/**
 * Split a migration file into individual SQL statements.
 *
 * D1's `exec()` splits on newlines, which breaks the multi-line `CREATE TABLE`
 * statements in `migrations/`, so the runtime migrator prepares one statement
 * at a time instead. Quoted text and comments are skipped so a `;` or `--`
 * inside a string literal or identifier is not mistaken for a boundary.
 */
export function splitSqlStatements(sql: string): string[] {
	const statements: string[] = [];
	let current = '';

	for (let i = 0; i < sql.length; i++) {
		const char = sql[i];
		const next = sql[i + 1];

		// Line comment: drop everything up to (not including) the newline.
		if (char === '-' && next === '-') {
			while (i < sql.length && sql[i] !== '\n') i++;
			current += '\n';
			continue;
		}

		// Block comment.
		if (char === '/' && next === '*') {
			i += 2;
			while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
			i++;
			current += ' ';
			continue;
		}

		// Quoted string or identifier — copied verbatim, doubled quotes included.
		if (char === "'" || char === '"' || char === '`') {
			current += char;
			i++;
			while (i < sql.length) {
				current += sql[i];
				if (sql[i] === char) {
					if (sql[i + 1] === char) {
						current += sql[i + 1];
						i += 2;
						continue;
					}
					break;
				}
				i++;
			}
			continue;
		}

		// Bracketed identifier, e.g. [my table].
		if (char === '[') {
			current += char;
			i++;
			while (i < sql.length && sql[i] !== ']') {
				current += sql[i];
				i++;
			}
			current += ']';
			continue;
		}

		if (char === ';') {
			push(statements, current);
			current = '';
			continue;
		}

		current += char;
	}

	push(statements, current);
	return statements;
}

function push(statements: string[], statement: string): void {
	const trimmed = statement.trim();
	if (trimmed) statements.push(trimmed);
}
