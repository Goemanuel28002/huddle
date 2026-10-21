import { pgTable, uuid, varchar, text, timestamp, boolean, index, uniqueIndex, integer, jsonb, primaryKey, foreignKey, unique } from 'drizzle-orm/pg-core';

export const rolePermissions = ['manage_invites', 'moderate_members', 'manage_channels', 'manage_roles', 'view_audit_log'] as const;
export type RolePermission = typeof rolePermissions[number];

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: varchar('username', { length: 32 }).notNull(),
  displayName: varchar('display_name', { length: 64 }).notNull(),
  email: varchar('email', { length: 254 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('users_username_uq').on(t.username), uniqueIndex('users_email_uq').on(t.email)]);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expiry_idx').on(t.expiresAt)]);

export const servers = pgTable('servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 80 }).notNull(),
  description: varchar('description', { length: 240 }).notNull().default(''),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const serverMembers = pgTable('server_members', {
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  isOwner: boolean('is_owner').notNull().default(false),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('server_members_pk').on(t.serverId, t.userId), index('server_members_user_idx').on(t.userId)]);

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 48 }).notNull(),
  permissions: jsonb('permissions').$type<RolePermission[]>().notNull().default([]),
  position: integer('position').notNull().default(0),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('roles_server_name_uq').on(t.serverId, t.name), unique('roles_server_id_id_uq').on(t.serverId, t.id)]);

export const memberRoles = pgTable('member_roles', {
  serverId: uuid('server_id').notNull(),
  userId: uuid('user_id').notNull(),
  roleId: uuid('role_id').notNull(),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.userId, t.roleId], name: 'member_roles_pk' }),
  index('member_roles_role_idx').on(t.serverId, t.roleId),
  foreignKey({ columns: [t.serverId, t.userId], foreignColumns: [serverMembers.serverId, serverMembers.userId], name: 'member_roles_member_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.serverId, t.roleId], foreignColumns: [roles.serverId, roles.id], name: 'member_roles_role_fk' }).onDelete('cascade'),
]);

export const channels = pgTable('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 64 }).notNull(),
  kind: varchar('kind', { length: 16 }).notNull().default('text'),
  position: timestamp('position', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('channels_server_idx').on(t.serverId, t.createdAt)]);

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  content: varchar('content', { length: 4000 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('messages_channel_created_idx').on(t.channelId, t.createdAt)]);

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  codeHash: varchar('code_hash', { length: 64 }).notNull().unique(),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  maxUses: integer('max_uses'),
  uses: integer('uses').notNull().default(0),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('invitations_server_idx').on(t.serverId, t.createdAt)]);

export const serverRestrictions = pgTable('server_restrictions', {
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 16 }).notNull(),
  actorId: uuid('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  reason: varchar('reason', { length: 500 }).notNull().default(''),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.serverId, t.userId, t.kind], name: 'server_restrictions_pk' }), index('server_restrictions_expiry_idx').on(t.serverId, t.kind, t.expiresAt)]);

export const moderationActions = pgTable('moderation_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  targetId: uuid('target_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  action: varchar('action', { length: 16 }).notNull(),
  reason: varchar('reason', { length: 500 }).notNull().default(''),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('moderation_actions_server_created_idx').on(t.serverId, t.createdAt), index('moderation_actions_target_idx').on(t.serverId, t.targetId, t.createdAt)]);
