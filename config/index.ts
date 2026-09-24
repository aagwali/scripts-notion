import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * database_id (REST, `collection_id` cote Notion) et data_source_id
 * (`collection://`, cote MCP) different pour une meme base : jamais l'un
 * deduit de l'autre, voir CLAUDE.md.
 */
export interface NotionDatabaseIds {
  database_id: string;
  data_source_id: string;
}

export interface InstanceConfig {
  notion: {
    databases: {
      tasks: NotionDatabaseIds;
      docs: NotionDatabaseIds;
      phases: NotionDatabaseIds;
      phasesArchive: NotionDatabaseIds;
      rawInputs: NotionDatabaseIds;
      recurringEvents: NotionDatabaseIds;
      planningAline: NotionDatabaseIds;
    };
  };
  google: {
    calendars: {
      personal: string;
      deadlines: string;
      reminders: string;
      planningAline: string;
    };
  };
}

const path = fileURLToPath(new URL("./instance.json", import.meta.url));

export const instance: InstanceConfig = JSON.parse(readFileSync(path, "utf-8"));
