import type { Client, Pool } from "pg";

export async function requireApplicationRole(client: Client | Pool) {
  const result = await client.query<{ safe: boolean }>(`SELECT
    NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication)
    AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member = r.oid)
    AND NOT has_database_privilege(current_user, current_database(), 'CREATE')
    AND NOT has_database_privilege(current_user, current_database(), 'TEMP')
    AND NOT EXISTS (SELECT FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND has_schema_privilege(current_user, n.oid, 'CREATE'))
    AND NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'drizzle') AND c.relowner = r.oid)
    AND has_table_privilege(current_user, 'public.audit_logs', 'SELECT')
    AND has_table_privilege(current_user, 'public.audit_logs', 'INSERT')
    AND NOT has_table_privilege(current_user, 'public.audit_logs', 'UPDATE')
    AND NOT has_table_privilege(current_user, 'public.audit_logs', 'DELETE')
    AND NOT has_table_privilege(current_user, 'public.audit_logs', 'TRUNCATE') AS safe
    FROM pg_roles r WHERE rolname = current_user`);
  if (!result.rows[0]?.safe) {
    throw new Error("DATABASE_URL にはDDL権限・監査ログ変更権限のない専用アプリ用ロールを設定してください。");
  }
}
