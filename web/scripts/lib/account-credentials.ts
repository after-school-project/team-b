import { drizzle } from "drizzle-orm/node-postgres";
import { randomBytes } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { Client } from "pg";
import { requireManagementRole } from "./database-management";
import { managementDatabaseConfig } from "./management-config";

export const schoolUsernamePattern = /^[a-z0-9_]{3,30}$/;

type Transaction = Parameters<Parameters<ReturnType<typeof drizzle>["transaction"]>[0]>[0];

export async function withAccountCredentials(
  username: string,
  outputPath: string,
  changeAccount: (tx: Transaction, password: string) => Promise<void>,
) {
  const client = new Client(managementDatabaseConfig(process.env));
  let outputCreated = false;
  try {
    await client.connect();
    await requireManagementRole(client);
    await drizzle(client).transaction(async (tx) => {
      const password = randomBytes(18).toString("base64url");
      await changeAccount(tx, password);
      // 出力先を用意できない場合はDBの変更も取り消す。
      const output = await open(outputPath, "wx", 0o600);
      outputCreated = true;
      try {
        await output.writeFile(JSON.stringify({ username, password }) + "\n", "utf8");
        await output.sync();
      } finally {
        await output.close();
      }
    });
  } catch (error) {
    if (outputCreated) await unlink(outputPath);
    throw error;
  } finally {
    await client.end();
  }
}
