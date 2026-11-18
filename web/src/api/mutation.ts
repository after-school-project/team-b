import { createHash } from "node:crypto";
import { and, eq, getTableName, inArray, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { db } from "../db/client";
import { operationReceipts } from "../db/moderation-schema";
import { communityUsers } from "../db/schema";
import { canonicalJson, type JsonValue } from "./canonical-json";
import type { MutationRequest } from "./request";
import { ApiError, type SuccessStatus } from "./response";

type Database = Pick<typeof db, "transaction">;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Receipt = typeof operationReceipts.$inferSelect;
type Resource = { type: string; id: string };

type MutationResult = {
  operationId: string;
  resource: Resource;
  version: number | null;
  state: string;
  committedAt: string;
  affectedCount?: number;
};

const stages = { resource: 0, application: 1, case: 2 } as const;
type TargetLock = {
  stage: keyof typeof stages;
  table: PgTable;
  idColumn: PgColumn;
  ids: readonly string[];
};

type MutationContext = {
  tx: Transaction;
  now: Date;
  requireLockedUsers: (...ids: string[]) => void;
};

type Mutation = {
  actorId: string;
  request: MutationRequest;
  body: JsonValue;
  resolveUserIds?: (tx: Transaction) => Promise<readonly string[]>;
  authorizeEntry: (tx: Transaction) => Promise<void>;
  targets?: (tx: Transaction, replayResource: Resource | null) => Promise<readonly TargetLock[]>;
  authorizeReplay: (context: MutationContext, original: MutationResult) => Promise<void>;
  execute: (context: MutationContext) =>
    Promise<Omit<MutationResult, "operationId" | "committedAt"> & { status: SuccessStatus }>;
};

class MissingUserLocks extends Error {
  constructor(readonly ids: string[]) {
    super("The transaction must restart with all related users.");
  }
}

async function lockTargets(tx: Transaction, targets: readonly TargetLock[]) {
  const groups = new Map<string, { table: PgTable; column: PgColumn; ids: Set<string> }>();
  for (const { stage, table, idColumn, ids } of targets) {
    if (idColumn.table !== table) throw new Error("ロック対象とID列が一致しません。");
    const key = stages[stage] + ":" + getTableName(table);
    const group = groups.get(key) ?? { table, column: idColumn, ids: new Set<string>() };
    if (group.column !== idColumn) throw new Error("同じテーブルのロックには同じID列を指定してください。");
    for (const id of ids) group.ids.add(id);
    groups.set(key, group);
  }
  for (const key of [...groups.keys()].sort()) {
    const { table, column, ids } = groups.get(key)!;
    if (ids.size > 0) {
      await tx.execute(sql`SELECT ${column} FROM ${table} WHERE ${inArray(column, [...ids])}
        ORDER BY ${column} FOR UPDATE`);
    }
  }
}

function receiptResult(receipt: Receipt): MutationResult {
  return {
    operationId: receipt.id,
    resource: { type: receipt.resultType, id: receipt.resultId },
    version: receipt.resultVersion,
    state: receipt.resultState,
    committedAt: receipt.createdAt.toISOString(),
    ...(receipt.affectedCount === null ? {} : { affectedCount: receipt.affectedCount }),
  };
}

function receiptStatus(receipt: Receipt): SuccessStatus {
  if (receipt.responseStatus === 200 || receipt.responseStatus === 201) return receipt.responseStatus;
  throw new Error("操作記録のHTTP状態が正しくありません。");
}

export function assertExpectedVersion(actual: number, expected: number) {
  if (actual !== expected) throw new ApiError("VERSION_CONFLICT");
}

export async function commitMutation(database: Database, mutation: Mutation): Promise<{
  data: MutationResult; status: SuccessStatus; replayed?: true;
}> {
  const { actorId, request: { requestKey, method, path }, body } = mutation;
  const requestHash = createHash("sha256").update(canonicalJson([method, path, body])).digest("hex");
  const requiredUsers = new Set([actorId]);

  // A changed dependency can require new user locks. Restart before taking them out of order.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await database.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
        const related = await mutation.resolveUserIds?.(tx) ?? [];
        const planned = new Set([...requiredUsers, ...related]);
        const locked = await tx.select({ id: communityUsers.userId }).from(communityUsers)
          .where(inArray(communityUsers.userId, [...planned]))
          .orderBy(communityUsers.userId).for("update");
        const lockedUsers = new Set(locked.map(({ id }) => id));
        if (!lockedUsers.has(actorId)) throw new ApiError("ACCOUNT_NOT_READY");
        await mutation.authorizeEntry(tx);

        // The user lock phase includes the actor. Holding that row through COMMIT
        // serializes the actor's receipt checks, including when no receipt exists.
        const [receipt] = await tx.select().from(operationReceipts).where(and(
          eq(operationReceipts.actorId, actorId), eq(operationReceipts.requestKey, requestKey),
        ));
        if (receipt && receipt.requestHash !== requestHash) throw new ApiError("IDEMPOTENCY_KEY_REUSED");

        const original = receipt ? receiptResult(receipt) : null;
        await lockTargets(tx, await mutation.targets?.(tx, original?.resource ?? null) ?? []);
        const { rows: [time] } = await tx.execute<{ epochMs: number }>(sql`
          SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::double precision AS "epochMs"
        `);
        const context: MutationContext = {
          tx,
          now: new Date(time.epochMs),
          requireLockedUsers(...ids) {
            const missing = ids.filter((id) => !planned.has(id));
            if (missing.length) throw new MissingUserLocks(missing);
            if (ids.some((id) => !lockedUsers.has(id))) throw new ApiError("NOT_FOUND");
          },
        };
        if (receipt && original) {
          await mutation.authorizeReplay(context, original);
          return { data: original, status: receiptStatus(receipt), replayed: true };
        }

        const result = await mutation.execute(context);
        const [saved] = await tx.insert(operationReceipts).values({
          actorId, requestKey, requestHash, responseStatus: result.status,
          resultType: result.resource.type, resultId: result.resource.id,
          resultVersion: result.version, resultState: result.state, affectedCount: result.affectedCount,
          createdAt: context.now,
        }).returning();
        return { data: receiptResult(saved), status: result.status };
      }, { isolationLevel: "read committed" });
    } catch (error) {
      if (!(error instanceof MissingUserLocks)) throw error;
      for (const id of error.ids) requiredUsers.add(id);
    }
  }
  throw new ApiError("TEMPORARILY_UNAVAILABLE");
}
