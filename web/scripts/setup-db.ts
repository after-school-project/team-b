import { randomBytes, randomUUID } from "node:crypto";
import nextEnv from "@next/env";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq, inArray } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { authOptions } from "../src/auth/options";
import * as authSchema from "../src/db/auth-schema";
import {
  accountRestrictions,
  communityUsers,
  identityRecords,
  profileReviews,
  profileRevisions,
  profiles,
  qaCategories,
} from "../src/db/schema";
import { demoAccounts, qaCategoryFixtures } from "./fixtures";
import { seedCommunityContent } from "./seed-community-content";

const credentialsDir = ".seed";
const credentialsFile = join(credentialsDir, "accounts.json");

async function readCredentials(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(credentialsFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {};
  }
}

async function prepareCredentials(usernames: string[]) {
  const credentials = await readCredentials();
  if (usernames.every((username) => credentials[username])) return credentials;

  for (const username of usernames) {
    credentials[username] ??= randomBytes(18).toString("base64url");
  }

  // Preserve the passwords across retries, even if the database transaction rolls back.
  await mkdir(credentialsDir, { recursive: true, mode: 0o700 });
  const temporaryFile = join(credentialsDir, randomUUID());
  try {
    await writeFile(temporaryFile, JSON.stringify(credentials, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryFile, credentialsFile);
  } finally {
    await rm(temporaryFile, { force: true });
  }
  return credentials;
}

async function seed(db: NodePgDatabase) {
  return db.transaction(async (tx) => {
    const existing = await tx.select({
      username: authSchema.user.username,
      userId: communityUsers.userId,
    })
      .from(authSchema.user)
      .leftJoin(communityUsers, eq(communityUsers.userId, authSchema.user.id))
      .where(inArray(authSchema.user.username, demoAccounts.map(({ username }) => username)));

    const userIds = new Map<string, string>();
    for (const { username, userId } of existing) {
      if (!username || !userId) {
        throw new Error(`Seed login ID already exists without a community account: ${username}`);
      }
      userIds.set(username, userId);
    }

    const newAccounts = demoAccounts.filter(({ username }) => !userIds.has(username));
    const credentials = await prepareCredentials(newAccounts.map(({ username }) => username));
    const options = authOptions(drizzleAdapter(tx, { provider: "pg", schema: authSchema }));
    const auth = betterAuth({
      ...options,
      emailAndPassword: { ...options.emailAndPassword, disableSignUp: false },
    });

    for (const fixture of newAccounts) {
      const { username, displayName, searchOptIn, ...access } = fixture;
      const { user } = await auth.api.signUpEmail({
        body: { username, name: displayName, email: `${username}@example.invalid`, password: credentials[username] },
      });
      const userId = user.id;
      userIds.set(username, userId);

      await tx.insert(communityUsers).values({
        userId, ...access, eligibilityStatus: "verified", provisioningStatus: "ready",
      });
      await tx.insert(identityRecords).values({
        userId,
        privateRealName: `架空ユーザー ${username}`,
        schoolReference: `DEMO-${username}`,
        verificationNote: "開発用の架空データ",
      });

      const [revision] = await tx.insert(profileRevisions).values({
        userId,
        revisionNo: 1,
        displayName,
        department: access.baseRole === "staff" ? null : "IT学科（架空）",
        graduationYear: access.baseRole === "alumni" || access.isGraduating ? 2026 : null,
        optionalValues: { bio: "開発用のサンプルプロフィールです。", interests: "Web開発" },
        fieldVisibility: { bio: "members", interests: "self" },
      }).returning({ id: profileRevisions.id });

      await tx.insert(profiles).values({ userId, currentRevisionId: revision.id, searchOptIn });
      if (access.profileState === "hidden") {
        await tx.insert(profileReviews).values({ userId, revisionId: revision.id });
      }
      if (access.accountStatus === "suspended") {
        const schoolManagerId = userIds.get("poc_school");
        if (!schoolManagerId) throw new Error("The school manager fixture must be provisioned first.");
        await tx.insert(accountRestrictions).values({
          userId,
          actorId: schoolManagerId,
          action: "suspend",
          publicReason: "開発環境で停止案内を確認するため。",
          internalReason: "架空アカウントの停止状態を確認するためのサンプル。",
        });
      }
    }

    await tx.insert(qaCategories).values(qaCategoryFixtures).onConflictDoNothing({ target: qaCategories.code });
    await seedCommunityContent(tx, userIds);
    return newAccounts.length;
  });
}

async function setup() {
  nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--seed-only") || args.length > 1) {
    throw new Error("Usage: setup-db.ts [--seed-only]");
  }
  const seedOnly = args.includes("--seed-only");
  const connectionString = process.env.DATABASE_URL_DIRECT;
  if (!connectionString) throw new Error("DATABASE_URL_DIRECT is required.");
  const url = new URL(connectionString);
  const localHosts = ["db", "localhost", "127.0.0.1", "[::1]"];
  if (
    process.env.NODE_ENV === "production" ||
    url.protocol !== "postgresql:" ||
    !localHosts.includes(url.hostname) ||
    url.pathname !== "/team_b_dev" ||
    url.search
  ) {
    throw new Error("Development seed can only run against the local team_b_dev database.");
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [7249352026]);
    const db = drizzle(client);
    if (!seedOnly) {
      await migrate(db, { migrationsFolder: "./drizzle" });
      await client.query(await readFile("./scripts/local-db-grants.sql", "utf8"));
    }
    const created = await seed(db);
    console.log(`Development database ready. Created ${created} fixture accounts.`);
  } finally {
    await client.end();
  }
}

setup().catch((error: unknown) => {
  console.error("Development database setup failed.", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
