import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import * as auth from "./auth-schema";
import * as community from "./schema";
import * as content from "./content-schema";
import * as moderation from "./moderation-schema";
import { applicationPool } from "./pool";

export const db = drizzle(applicationPool(), {
  schema: { ...auth, ...community, ...content, ...moderation },
});
