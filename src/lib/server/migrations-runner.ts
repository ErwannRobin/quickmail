import type { D1Database } from '@cloudflare/workers-types';
import { splitSqlStatements } from './sql-statements';

export type Migration = { name: string; sql: string };

/** wrangler's own bookkeeping table, so the CLI and the Worker agree. */
export const MIGRATIONS_TABLE = 'd1_migrations';

/**
 * A table the first migration creates. If bookkeeping says migrations ran but
 * this is missing, the bookkeeping is wrong and everything is applied again.
 */
export const ANCHOR_TABLE = 'users';

/**
 * Re-running a migration over a database that already holds part of it is
 * expected: an earlier attempt can die halfway, and two Worker isolates can
 * race on the first request after a deploy. Those errors mean "already done".
 */
const ALREADY_APPLIED = /already exists|duplicate column name/i;

/**
 * Bring `db` up to date with `migrations` (ordered oldest first).
 *
 * Statements run one at a time rather than through `db.batch()` so a partly
 * applied migration can be finished instead of failing forever, and a
 * migration is recorded only after its statements succeed — never before.
 */
export async function runMigrations(db: D1Database, migrations: Migration[]): Promise<void> {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT UNIQUE,
				applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`
		)
		.run();

	let applied = await readApplied(db);

	if (applied.size > 0 && !(await hasTable(db, ANCHOR_TABLE))) {
		console.warn(
			`[migrate] ${MIGRATIONS_TABLE} lists ${applied.size} migration(s) but table "${ANCHOR_TABLE}" is missing. Reapplying from the start.`
		);
		await db.prepare(`DELETE FROM ${MIGRATIONS_TABLE}`).run();
		applied = new Set();
	}

	const pending = migrations.filter((migration) => !applied.has(migration.name));
	if (pending.length === 0) return;

	console.log(`[migrate] applying ${pending.length} migration(s)`);
	for (const migration of pending) {
		await applyMigration(db, migration);
	}

	// Better a clear error here than `no such table` from the first query.
	if (!(await hasTable(db, ANCHOR_TABLE))) {
		throw new Error(
			`D1 migrations ran but table "${ANCHOR_TABLE}" is still missing. Check that migrations/ is bundled with the Worker.`
		);
	}
}

async function applyMigration(db: D1Database, migration: Migration): Promise<void> {
	for (const statement of splitSqlStatements(migration.sql)) {
		try {
			await db.prepare(statement).run();
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (ALREADY_APPLIED.test(reason)) continue;
			throw new Error(
				`D1 migration ${migration.name} failed on \`${firstLine(statement)}\`: ${reason}`
			);
		}
	}

	await db
		.prepare(`INSERT OR IGNORE INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`)
		.bind(migration.name)
		.run();
	console.log(`[migrate] applied ${migration.name}`);
}

async function readApplied(db: D1Database): Promise<Set<string>> {
	const { results } = await db
		.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`)
		.all<{ name: string }>();
	return new Set(results.map((row) => row.name));
}

async function hasTable(db: D1Database, table: string): Promise<boolean> {
	const row = await db
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
		.bind(table)
		.first<{ name: string }>();
	return Boolean(row);
}

function firstLine(statement: string): string {
	const line = statement.split('\n', 1)[0].trim();
	return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
