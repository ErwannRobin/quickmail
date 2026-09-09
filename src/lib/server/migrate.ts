import type { D1Database } from '@cloudflare/workers-types';
import { splitSqlStatements } from './sql-statements';

/**
 * Applies pending D1 migrations from the running Worker.
 *
 * `wrangler d1 migrations apply` only runs when someone runs it — the
 * "Deploy to Cloudflare" button provisions an empty D1 database and then
 * deploys, so the first visit used to hit a database with no tables. The
 * Worker now brings the schema up to date itself on the first request.
 *
 * Bookkeeping uses wrangler's own `d1_migrations` table and file names, so a
 * database migrated by the CLI is left alone, and `wrangler d1 migrations
 * apply` stays correct on a database migrated here.
 */
const MIGRATIONS_TABLE = 'd1_migrations';

const files = import.meta.glob('/migrations/*.sql', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

const MIGRATIONS = Object.entries(files)
	.map(([path, sql]) => ({ name: path.slice(path.lastIndexOf('/') + 1), sql }))
	.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** Resolved once per isolate; reset on failure so the next request retries. */
let inFlight: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
	if (!inFlight) {
		inFlight = applyPendingMigrations(db).catch((error) => {
			inFlight = null;
			throw error;
		});
	}
	return inFlight;
}

/** Test seam: forget the cached result. */
export function resetSchemaCache(): void {
	inFlight = null;
}

async function applyPendingMigrations(db: D1Database): Promise<void> {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT UNIQUE,
				applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`
		)
		.run();

	const { results } = await db
		.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`)
		.all<{ name: string }>();
	const applied = new Set(results.map((row) => row.name));

	for (const migration of MIGRATIONS) {
		if (applied.has(migration.name)) continue;
		await applyMigration(db, migration);
	}
}

async function applyMigration(
	db: D1Database,
	migration: { name: string; sql: string }
): Promise<void> {
	// Claim the migration before running it. `name` is UNIQUE, so a second
	// isolate racing us on the first request after a deploy loses the insert
	// and skips the file instead of applying it twice.
	const claim = await db
		.prepare(`INSERT OR IGNORE INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`)
		.bind(migration.name)
		.run();
	if (!claim.meta.changes) return;

	const statements = splitSqlStatements(migration.sql);
	try {
		if (statements.length) {
			await db.batch(statements.map((statement) => db.prepare(statement)));
		}
	} catch (error) {
		// Release the claim so a later request can retry.
		await db
			.prepare(`DELETE FROM ${MIGRATIONS_TABLE} WHERE name = ?`)
			.bind(migration.name)
			.run();
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`D1 migration ${migration.name} failed: ${reason}`);
	}
}
