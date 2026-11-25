import { listGraduationCandidates, parseGraduationCandidateQuery } from "@/admin/graduation";
import { defineAdminApiRoute } from "@/api/admin-route";

export const runtime = "nodejs";

/**
 * API-GR-01：卒業区分の変更候補（AD-13）。学校管理者だけが利用できる。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute("school", {
  async GET(request, _context, viewer) {
    const query = parseGraduationCandidateQuery(new URL(request.url));
    const { db } = await import("@/db/client");
    return listGraduationCandidates(db, viewer, query);
  },
});
