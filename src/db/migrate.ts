import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import path from "node:path";

/** Applies pending migrations. Uses MIGRATION_DATABASE_URL (owner role) if set, else DATABASE_URL. */
export async function runMigrations(url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL (or MIGRATION_DATABASE_URL) is required to run migrations");
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: path.join(process.cwd(), "drizzle") });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && /migrate\.(ts|js)$/.test(process.argv[1])) {
  runMigrations()
    .then(() => {
      console.log(JSON.stringify({ level: "info", msg: "migrations applied" }));
    })
    .catch((err) => {
      console.error(JSON.stringify({ level: "error", msg: "migration failed", err: String(err) }));
      process.exit(1);
    });
}
