/**
 * Truncate ALL tables in the DATABASE_URL database (MySQL), keeping schema/migrations.
 *
 * Safety:
 * - Requires CONFIRM=YES env var or it exits.
 * - Refuses to run if DATABASE_URL is missing.
 *
 * Usage:
 *   CONFIRM=YES tsx scripts/truncate_db.ts
 *
 * Optional:
 *   KEEP_TABLES="_prisma_migrations,User,Company" CONFIRM=YES tsx scripts/truncate_db.ts
 */

import mysql from "mysql2/promise";

function requiredEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function parseDatabaseName(databaseUrl: string) {
  const u = new URL(databaseUrl);
  const db = u.pathname?.replace(/^\//, "");
  if (!db) throw new Error("DATABASE_URL is missing database name (e.g. .../cashflow_dev)");
  return db;
}

async function main() {
  if ((process.env.CONFIRM ?? "").toUpperCase() !== "YES") {
    console.error(
      [
        "Refusing to truncate without explicit confirmation.",
        "Set CONFIRM=YES to proceed.",
        "Example: CONFIRM=YES tsx scripts/truncate_db.ts",
      ].join("\n")
    );
    process.exit(1);
  }

  const databaseUrl = requiredEnv("DATABASE_URL");
  const databaseName = parseDatabaseName(databaseUrl);

  const keepTables = new Set(
    (process.env.KEEP_TABLES ?? "_prisma_migrations")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const conn = await mysql.createConnection(databaseUrl);
  try {
    const [rows] = await conn.execute(
      `SELECT TABLE_NAME as tableName
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = ?
         AND TABLE_TYPE = 'BASE TABLE'`,
      [databaseName]
    );

    const tableNames = (rows as any[])
      .map((r) => String(r.tableName))
      .filter((t) => !keepTables.has(t));

    if (tableNames.length === 0) {
      console.log(`No tables to truncate in schema '${databaseName}' (after KEEP_TABLES filter).`);
      return;
    }

    console.log(`Database: ${databaseName}`);
    console.log(`KEEP_TABLES: ${[...keepTables].join(", ")}`);
    console.log(`Truncating ${tableNames.length} tables...`);

    await conn.execute("SET FOREIGN_KEY_CHECKS = 0;");
    for (const t of tableNames) {
      await conn.execute(`TRUNCATE TABLE \`${t}\`;`);
    }
    await conn.execute("SET FOREIGN_KEY_CHECKS = 1;");

    console.log("Done. Database is now clean.");
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


