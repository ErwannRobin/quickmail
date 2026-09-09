import type { D1Database } from '@cloudflare/workers-types';
import { runMigrations, type Migration } from './migrations-runner';

/**
 * Applies pending D1 migrations from the running Worker.
 *
 * `wrangler d1 migrations apply` only runs when someone runs it — the
 * "Deploy to Cloudflare" button provisions an empty D1 database and then
 * deploys, so the first visit would otherwise hit a database with no tables.
 *
 * Bookkeeping uses wrangler's `d1_migrations` table and file names, so a
 * database migrated by the CLI is left alone, and `wrangler d1 migrations
 * apply` stays correct on a database migrated here.
 */
const files = import.meta.glob('/migrations/*.sql', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

const MIGRATIONS: Migration[] = Object.entries(files)
	.map(([path, sql]) => ({ name: path.slice(path.lastIndexOf('/') + 1), sql }))
	.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** Resolved once per isolate; cleared on failure so the next request retries. */
let inFlight: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
	if (!inFlight) {
		inFlight = run(db).catch((error) => {
			inFlight = null;
			throw error;
		});
	}
	return inFlight;
}

async function run(db: D1Database): Promise<void> {
	if (MIGRATIONS.length === 0) {
		throw new Error('No migrations were bundled with the Worker — expected migrations/*.sql.');
	}
	await runMigrations(db, MIGRATIONS);
}
