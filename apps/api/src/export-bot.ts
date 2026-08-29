import type { AdapterContext, AgentHomeStore } from "@rakazo/adapter-kit";
import {
  EXPORT_MAX_FILE_BYTES,
  EXPORT_MAX_FILE_COUNT,
  EXPORT_MAX_MESSAGE_COUNT,
  EXPORT_MAX_TOTAL_BYTES,
  type ExportManifest,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { loadAllMessages } from "./thread-message-pages.js";

export const EXPORT_MESSAGE_PAGE_SIZE = 500;

export type ExportLimitKind = "totalBytes" | "fileCount" | "fileBytes" | "messageCount";

const EXPORT_LIMIT_LABEL: Record<ExportLimitKind, string> = {
  totalBytes: "total size",
  fileCount: "file count",
  fileBytes: "per-file size",
  messageCount: "message count",
};

export class ExportTooLargeError extends Error {
  constructor(readonly limit: ExportLimitKind) {
    super(`Export exceeds the ${EXPORT_LIMIT_LABEL[limit]} limit`);
    this.name = "ExportTooLargeError";
  }
}

export type ExportLimits = {
  maxTotalBytes: number;
  maxFileCount: number;
  maxFileBytes: number;
  maxMessageCount: number;
};

export const DEFAULT_EXPORT_LIMITS: ExportLimits = {
  maxTotalBytes: EXPORT_MAX_TOTAL_BYTES,
  maxFileCount: EXPORT_MAX_FILE_COUNT,
  maxFileBytes: EXPORT_MAX_FILE_BYTES,
  maxMessageCount: EXPORT_MAX_MESSAGE_COUNT,
};

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function addBytes(used: number, extra: number, max: number): number {
  const next = used + extra;
  if (next > max) throw new ExportTooLargeError("totalBytes");
  return next;
}

async function collectExportFiles(
  home: AgentHomeStore,
  homeKey: string,
  context: AdapterContext,
  limits: ExportLimits,
  usedBytes: number,
): Promise<{ files: Array<{ path: string; content: string }>; usedBytes: number }> {
  const files: Array<{ path: string; content: string }> = [];
  try {
    for await (const file of home.exportHome(homeKey, context, {
      maxFileBytes: limits.maxFileBytes,
    })) {
      if (files.length >= limits.maxFileCount) throw new ExportTooLargeError("fileCount");
      if (file.content.byteLength > limits.maxFileBytes) {
        throw new ExportTooLargeError("fileBytes");
      }
      usedBytes = addBytes(usedBytes, file.content.byteLength, limits.maxTotalBytes);
      files.push({
        path: file.path,
        content: new TextDecoder().decode(file.content),
      });
    }
  } catch (error) {
    if (error instanceof ExportTooLargeError) throw error;
    if (error instanceof Error && /exceeds \d+ bytes/.test(error.message)) {
      throw new ExportTooLargeError("fileBytes");
    }
    throw error;
  }
  return { files, usedBytes };
}

export async function buildBotExportManifest(input: {
  bot: { name: string; title: string; description: string; instructions: string };
  botId: string;
  threadId: string;
  workspaceId: string;
  homeKey: string;
  home: AgentHomeStore;
  prisma: PrismaClient;
  exportContext: AdapterContext;
  limits?: ExportLimits;
  now?: Date;
}): Promise<ExportManifest> {
  const limits = input.limits ?? DEFAULT_EXPORT_LIMITS;
  const [memory, routines] = await Promise.all([
    input.prisma.memoryDocument.findMany({
      where: { botId: input.botId, workspaceId: input.workspaceId },
    }),
    input.prisma.routine.findMany({
      where: { botId: input.botId, workspaceId: input.workspaceId },
    }),
  ]);

  let usedBytes = 0;
  const memoryFiles = memory.map((row) => {
    usedBytes = addBytes(
      usedBytes,
      utf8Bytes(row.path) + utf8Bytes(row.content),
      limits.maxTotalBytes,
    );
    return { path: row.path, content: row.content };
  });
  const routineRows = routines.map((row) => {
    usedBytes = addBytes(
      usedBytes,
      utf8Bytes(row.name) + utf8Bytes(row.prompt),
      limits.maxTotalBytes,
    );
    return {
      name: row.name,
      prompt: row.prompt,
      crons: row.crons,
      timezone: row.timezone,
    };
  });

  const collected = await collectExportFiles(
    input.home,
    input.homeKey,
    input.exportContext,
    limits,
    usedBytes,
  );

  let history: Awaited<ReturnType<typeof loadAllMessages>>;
  try {
    history = await loadAllMessages(input.prisma, input.threadId, EXPORT_MESSAGE_PAGE_SIZE, {
      maxMessages: limits.maxMessageCount,
      maxSerializedBytes: Math.max(0, limits.maxTotalBytes - collected.usedBytes),
    });
  } catch (error) {
    if (error instanceof Error && /exceeds \d+ messages/.test(error.message)) {
      throw new ExportTooLargeError("messageCount");
    }
    if (error instanceof Error && /exceeds \d+ bytes/.test(error.message)) {
      throw new ExportTooLargeError("totalBytes");
    }
    throw error;
  }

  return {
    version: 1,
    exportedAt: (input.now ?? new Date()).toISOString(),
    bot: {
      name: input.bot.name,
      title: input.bot.title,
      description: input.bot.description,
      instructions: input.bot.instructions,
    },
    memory: memoryFiles,
    routines: routineRows,
    files: collected.files,
    history,
  };
}
