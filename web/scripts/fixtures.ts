import type { communityUsers } from "../src/db/schema";

type Fixture = Pick<
  typeof communityUsers.$inferInsert,
  "baseRole" | "isGraduating" | "schoolManager" | "appManager" | "accountStatus" | "profileState"
> & {
  username: string;
  displayName: string;
  searchOptIn?: boolean;
};

export const demoAccounts: Fixture[] = [
  { username: "poc_school", displayName: "学校管理者（サンプル）", baseRole: "staff", schoolManager: true },
  { username: "poc_s001", displayName: "はる", baseRole: "student" },
  { username: "poc_s002", displayName: "みなと", baseRole: "student", isGraduating: true, searchOptIn: true },
  { username: "poc_a001", displayName: "あおい", baseRole: "alumni", searchOptIn: true },
  { username: "poc_staff", displayName: "学校職員（サンプル）", baseRole: "staff" },
  { username: "poc_s_mgr", displayName: "在校生アプリ管理者", baseRole: "student", appManager: true },
  { username: "poc_a_mgr", displayName: "卒業生アプリ管理者", baseRole: "alumni", appManager: true },
  { username: "poc_staff_mgr", displayName: "職員アプリ管理者", baseRole: "staff", appManager: true },
  { username: "poc_hidden", displayName: "ゆう", baseRole: "alumni", profileState: "hidden", searchOptIn: true },
  { username: "poc_suspended", displayName: "りく", baseRole: "student", accountStatus: "suspended" },
];

export const qaCategoryFixtures = [
  { code: "career", name: "就職・キャリア" },
  { code: "learning", name: "技術・学習" },
  { code: "projects", name: "制作・プロジェクト" },
  { code: "chat", name: "雑談" },
];
