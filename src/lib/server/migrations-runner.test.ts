import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import { ANCHOR_TABLE, MIGRATIONS_TABLE, runMigrations, type Migration } from './migrations-runner';

/**
 * Enough of D1 to exercise the runner: a set of table names, the bookkeeping
 * rows, and a record of every migration statement that ran.
 */
function fakeDb(options: { applied?: string[]; tables?: string[]; fail?: string } = {}) {
	const tables = new Set(options.tables ?? []);
	const bookkeeping = new Set(options.applied ?? []);
	const ran: string[] = [];

	function exec(sql: string, values: unknown[]): unknown[] {
		const text = sql.trim();

		if (/^CREATE TABLE IF NOT EXISTS d1_migrations/i.test(text)) return [];
		if (/^SELECT name FROM d1_migrations$/i.test(text)) {
			return [...bookkeeping].map((name) => ({ name }));
		}
		if (/^DELETE FROM d1_migrations$/i.test(text)) {
			bookkeeping.clear();
			return [];
		}
		if (/^INSERT OR IGNORE INTO d1_migrations/i.test(text)) {
			bookkeeping.add(String(values[0]));
			return [];
		}
		if (/FROM sqlite_master/i.test(text)) {
			const name = String(values[0]);
			return tables.has(name) ? [{ name }] : [];
		}

		ran.push(text);
		if (options.fail && text.includes(options.fail)) throw new Error('near "OOPS": syntax error');

		const created = /^CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i.exec(text);
		if (created) {
			if (tables.has(created[1])) throw new Error(`table ${created[1]} already exists`);
			tables.add(created[1]);
		}
		return [];
	}

	function statement(sql: string, values: unknown[] = []) {
		return {
			bind: (...bound: unknown[]) => statement(sql, bound),
			async run() {
				exec(sql, values);
				return { success: true };
			},
			async first() {
				return exec(sql, values)[0] ?? null;
			},
			async all() {
				return { results: exec(sql, values) };
			}
		};
	}

	return {
		db: { prepare: (sql: string) => statement(sql) } as unknown as D1Database,
		tables,
		bookkeeping,
		ran
	};
}

const MIGRATIONS: Migration[] = [
	{ name: '0001_init.sql', sql: `CREATE TABLE ${ANCHOR_TABLE} (id TEXT);` },
	{ name: '0002_more.sql', sql: 'CREATE TABLE emails (id TEXT);\nCREATE INDEX idx ON emails(id);' }
];

describe('runMigrations', () => {
	test('applies every migration to an empty database', async () => {
		const { db, tables, bookkeeping } = fakeDb();

		await runMigrations(db, MIGRATIONS);

		assert.ok(tables.has(ANCHOR_TABLE));
		assert.ok(tables.has('emails'));
		assert.deepEqual([...bookkeeping], ['0001_init.sql', '0002_more.sql']);
	});

	test('does nothing when every migration is recorded and the schema is there', async () => {
		const { db, ran } = fakeDb({
			applied: MIGRATIONS.map((migration) => migration.name),
			tables: [ANCHOR_TABLE, 'emails']
		});

		await runMigrations(db, MIGRATIONS);

		assert.deepEqual(ran, []);
	});

	test('reapplies everything when bookkeeping claims migrations the schema lacks', async () => {
		const { db, tables, bookkeeping } = fakeDb({
			applied: MIGRATIONS.map((migration) => migration.name)
		});

		await runMigrations(db, MIGRATIONS);

		assert.ok(tables.has(ANCHOR_TABLE));
		assert.deepEqual([...bookkeeping], ['0001_init.sql', '0002_more.sql']);
	});

	test('finishes a migration that was only half applied', async () => {
		const { db, tables, bookkeeping } = fakeDb({
			applied: ['0001_init.sql'],
			tables: [ANCHOR_TABLE, 'emails']
		});

		await runMigrations(db, MIGRATIONS);

		assert.deepEqual([...bookkeeping], ['0001_init.sql', '0002_more.sql']);
		assert.ok(tables.has('emails'));
	});

	test('records a migration only after it succeeds, and names it on failure', async () => {
		const { db, bookkeeping } = fakeDb({ fail: 'CREATE TABLE emails' });

		await assert.rejects(
			() => runMigrations(db, MIGRATIONS),
			/D1 migration 0002_more\.sql failed on `CREATE TABLE emails \(id TEXT\)`/
		);
		assert.deepEqual([...bookkeeping], ['0001_init.sql']);
	});

	test('fails loudly if the anchor table is still missing afterwards', async () => {
		const { db } = fakeDb();

		await assert.rejects(
			() => runMigrations(db, [{ name: '0001_init.sql', sql: 'CREATE TABLE other (id TEXT);' }]),
			/is still missing/
		);
	});
});
