import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

const baseRoles = ["student", "alumni", "staff"] as const;
type ProfileField = "bio" | "occupation" | "interests";
type ProfileVisibility = "members" | "self";

export const communityUsers = pgTable("community_users", {
  userId: text("user_id").primaryKey().references(() => user.id),
  baseRole: text("base_role", { enum: baseRoles }).notNull(),
  isGraduating: boolean("is_graduating").notNull().default(false),
  schoolManager: boolean("school_manager").notNull().default(false),
  appManager: boolean("app_manager").notNull().default(false),
  accountStatus: text("account_status", { enum: ["active", "suspended"] }).notNull().default("active"),
  profileState: text("profile_state", { enum: ["public", "hidden"] }).notNull().default("public"),
  eligibilityStatus: text("eligibility_status", { enum: ["pending", "verified"] }).notNull().default("pending"),
  provisioningStatus: text("provisioning_status", { enum: ["pending", "ready"] }).notNull().default("pending"),
  version: integer("version").notNull().default(1),
}, (table) => [
  check("community_users_role", sql`${table.baseRole} IN ('student', 'alumni', 'staff')`),
  check("community_users_graduating_student", sql`NOT ${table.isGraduating} OR ${table.baseRole} = 'student'`),
  check("community_users_school_manager_staff", sql`NOT ${table.schoolManager} OR ${table.baseRole} = 'staff'`),
  check("community_users_account_status", sql`${table.accountStatus} IN ('active', 'suspended')`),
  check("community_users_profile_state", sql`${table.profileState} IN ('public', 'hidden')`),
  check("community_users_eligibility", sql`${table.eligibilityStatus} IN ('pending', 'verified')`),
  check("community_users_provisioning", sql`${table.provisioningStatus} IN ('pending', 'ready')`),
  check("community_users_version", sql`${table.version} > 0`),
]);

export const identityRecords = pgTable("identity_records", {
  userId: text("user_id").primaryKey().references(() => communityUsers.userId),
  privateRealName: text("private_real_name").notNull(),
  schoolReference: text("school_reference").notNull(),
  verificationNote: text("verification_note"),
});

export const profileRevisions = pgTable("profile_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => communityUsers.userId),
  revisionNo: integer("revision_no").notNull(),
  displayName: text("display_name").notNull(),
  department: text("department"),
  entryYear: integer("entry_year"),
  graduationYear: integer("graduation_year"),
  optionalValues: jsonb("optional_values").$type<Partial<Record<ProfileField, string>>>().notNull().default({}),
  fieldVisibility: jsonb("field_visibility").$type<Partial<Record<ProfileField, ProfileVisibility>>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("profile_revisions_user_revision_no").on(table.userId, table.revisionNo),
  unique("profile_revisions_user_id_id").on(table.userId, table.id),
  check("profile_revisions_revision_no", sql`${table.revisionNo} > 0`),
]);

export const profiles = pgTable("profiles", {
  userId: text("user_id").primaryKey().references(() => communityUsers.userId),
  currentRevisionId: uuid("current_revision_id").notNull(),
  searchOptIn: boolean("search_opt_in").notNull().default(false),
  version: integer("version").notNull().default(1),
}, (table) => [
  foreignKey({
    name: "profiles_current_revision_owner_fk",
    columns: [table.userId, table.currentRevisionId],
    foreignColumns: [profileRevisions.userId, profileRevisions.id],
  }),
  check("profiles_version", sql`${table.version} > 0`),
]);

export const profileReviews = pgTable("profile_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => communityUsers.userId),
  revisionId: uuid("revision_id").notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  version: integer("version").notNull().default(1),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  reviewerId: text("reviewer_id").references(() => communityUsers.userId),
  decisionReason: text("decision_reason"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (table) => [
  foreignKey({
    name: "profile_reviews_revision_owner_fk",
    columns: [table.userId, table.revisionId],
    foreignColumns: [profileRevisions.userId, profileRevisions.id],
  }),
  uniqueIndex("profile_reviews_one_pending").on(table.userId).where(sql`${table.status} = 'pending'`),
  index("profile_reviews_status_date").on(table.status, table.submittedAt, table.id),
  index("profile_reviews_user_date").on(table.userId, table.submittedAt, table.id),
  check("profile_reviews_status", sql`${table.status} IN ('pending', 'approved', 'rejected')`),
  check("profile_reviews_decision_metadata", sql`
    (${table.status} = 'pending' AND ${table.reviewerId} IS NULL
      AND ${table.decidedAt} IS NULL AND ${table.decisionReason} IS NULL)
    OR (${table.status} IN ('approved', 'rejected')
      AND ${table.reviewerId} IS NOT NULL AND ${table.decidedAt} IS NOT NULL)
  `),
  check("profile_reviews_rejection_reason", sql`
    ${table.status} <> 'rejected' OR coalesce(${table.decisionReason} ~ '[^[:space:]]', false)
  `),
  check("profile_reviews_version", sql`${table.version} > 0`),
]);

export const accountRestrictions = pgTable("account_restrictions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => communityUsers.userId),
  actorId: text("actor_id").notNull().references(() => communityUsers.userId),
  action: text("action", { enum: ["suspend", "release"] }).notNull(),
  publicReason: text("public_reason").notNull(),
  internalReason: text("internal_reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("account_restrictions_action", sql`${table.action} IN ('suspend', 'release')`),
  check("account_restrictions_reasons", sql`btrim(${table.publicReason}) <> '' AND btrim(${table.internalReason}) <> ''`),
  index("account_restrictions_user_date").on(table.userId, table.createdAt, table.id),
]);

export const qaCategories = pgTable("qa_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
});

export const managerRoleChanges = pgTable("manager_role_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => communityUsers.userId),
  actorId: text("actor_id").notNull().references(() => communityUsers.userId),
  beforeAppManager: boolean("before_app_manager").notNull(),
  afterAppManager: boolean("after_app_manager").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("manager_role_changes_user_date").on(table.userId, table.createdAt, table.id),
  check("manager_role_changes_changed", sql`${table.beforeAppManager} <> ${table.afterAppManager}`),
]);

export const graduationChanges = pgTable("graduation_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: uuid("batch_id").notNull(),
  userId: text("user_id").notNull().references(() => communityUsers.userId),
  actorId: text("actor_id").notNull().references(() => communityUsers.userId),
  changeKind: text("change_kind", { enum: ["graduation", "correction"] }).notNull(),
  beforeRole: text("before_role", { enum: ["student", "alumni"] }).notNull(),
  afterRole: text("after_role", { enum: ["student", "alumni"] }).notNull(),
  beforeGraduating: boolean("before_graduating").notNull(),
  afterGraduating: boolean("after_graduating").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("graduation_changes_batch_user").on(table.batchId, table.userId),
  index("graduation_changes_user_date").on(table.userId, table.createdAt, table.id),
  check("graduation_changes_roles", sql`
    ${table.beforeRole} IN ('student', 'alumni') AND ${table.afterRole} IN ('student', 'alumni')
    AND (NOT ${table.beforeGraduating} OR ${table.beforeRole} = 'student')
    AND (NOT ${table.afterGraduating} OR ${table.afterRole} = 'student')
  `),
  check("graduation_changes_kind", sql`
    ${table.changeKind} = 'correction'
    OR (${table.changeKind} = 'graduation' AND ${table.beforeGraduating} AND ${table.afterRole} = 'alumni')
  `),
]);
