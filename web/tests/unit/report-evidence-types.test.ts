import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";
import { preserveEvidence } from "../../src/api/report-evidence";
import { handoffCasesOfDeletedTarget } from "../../src/api/report-handoff";

describe("通報証拠・引継ぎの共通処理の引数（#47 ③④）", () => {
  it("通常の db を受け付けず、トランザクションの中でだけ呼べる（型検査で確認）", () => {
    // 実行はしない。型検査（npm run typecheck）で @ts-expect-error が満たされることを確認する。
    const typeOnly = (db: NodePgDatabase) => {
      // @ts-expect-error 証拠の保全は、案件の行ロックと書き込みを1つのトランザクションで確定する。
      void preserveEvidence(db, { target: { kind: "question", questionId: "question" }, at: new Date() });
      // @ts-expect-error 引継ぎも同じ。
      void handoffCasesOfDeletedTarget({ tx: db, requireLockedUsers: () => {} }, {
        target: { kind: "question", questionId: "question" }, at: new Date(),
      });
    };
    expect(typeof typeOnly).toBe("function");
  });
});
