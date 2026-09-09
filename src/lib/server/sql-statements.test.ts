import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { splitSqlStatements } from './sql-statements';

describe('splitSqlStatements', () => {
	test('keeps multi-line statements whole', () => {
		assert.deepEqual(
			splitSqlStatements(`CREATE TABLE users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL
);

CREATE INDEX idx ON users(email);`),
			[
				'CREATE TABLE users (\n\tid TEXT PRIMARY KEY,\n\temail TEXT NOT NULL\n)',
				'CREATE INDEX idx ON users(email)'
			]
		);
	});

	test('drops line and block comments', () => {
		assert.deepEqual(splitSqlStatements('-- a note\nSELECT 1; /* b */ SELECT 2;'), [
			'SELECT 1',
			'SELECT 2'
		]);
	});

	test('does not split inside string literals', () => {
		assert.deepEqual(splitSqlStatements(`UPDATE t SET s = 'a; b -- c' WHERE id = 1;`), [
			`UPDATE t SET s = 'a; b -- c' WHERE id = 1`
		]);
	});

	test('handles doubled quotes and quoted identifiers', () => {
		assert.deepEqual(splitSqlStatements(`INSERT INTO "my;table" (a) VALUES ('it''s; fine');`), [
			`INSERT INTO "my;table" (a) VALUES ('it''s; fine')`
		]);
	});

	test('ignores empty statements and trailing whitespace', () => {
		assert.deepEqual(splitSqlStatements(';;\nSELECT 1;;\n  '), ['SELECT 1']);
	});
});

describe('bundled migrations', () => {
	const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
	const files = readdirSync(dir).filter((name) => name.endsWith('.sql'));

	test('every migration yields statements with no leftover comments', () => {
		assert.ok(files.length > 0);
		for (const file of files) {
			const statements = splitSqlStatements(readFileSync(join(dir, file), 'utf8'));
			assert.ok(statements.length > 0, `${file} produced no statements`);
			for (const statement of statements) {
				assert.ok(!statement.includes('--'), `${file} kept a comment: ${statement}`);
			}
		}
	});
});
