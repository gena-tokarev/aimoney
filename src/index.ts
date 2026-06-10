import "dotenv/config";

import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { google, sheets_v4 } from "googleapis";
import OpenAI from "openai";
import { Context, Markup, Telegraf } from "telegraf";
import { message } from "telegraf/filters";

type EntryType = "расход" | "доход";

type Entry = {
  type: EntryType;
  date: string;
  tags: string[];
  description: string;
  amount: number;
  currency: string;
  raw_text: string;
};

type SheetEntryRow = {
  type: EntryType;
  date: string;
  tags: string[];
  description: string;
  amount: string;
  currency: string;
  raw_text: string;
};

type SheetInfo = {
  sheetId: number;
  title: string;
};

type UndoOperation = {
  chatId: number;
  createdAt: number;
  endRow: number;
  messageId: number;
  operationId: string;
  sheetId: number;
  startRow: number;
  userId: number;
};

type ReplyContext = {
  chat?: Context["chat"];
  from?: Context["from"];
  reply: Context["reply"];
};

const {
  TELEGRAM_BOT_TOKEN,
  OPENAI_API_KEY,
  GOOGLE_SHEET_ID,
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !OPENAI_API_KEY || !GOOGLE_SHEET_ID) {
  throw new Error(
    "Missing required environment variables. Expected TELEGRAM_BOT_TOKEN, OPENAI_API_KEY, and GOOGLE_SHEET_ID.",
  );
}

const credentialsPath = path.resolve(process.cwd(), "credentials.json");

if (!existsSync(credentialsPath)) {
  throw new Error(`Missing Google service account file: ${credentialsPath}`);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const DEFAULT_TRANSCRIPTION_LANGUAGE = "ru";
const DEFAULT_CURRENCY = "PLN";
const RECENT_ROWS_LIMIT = 12;
const OLDER_ROWS_SAMPLE_LIMIT = 8;
const TAG_EXAMPLES_PER_TAG = 3;
const UNDO_WINDOW_MS = 15 * 60 * 1000;
const FAMILY_CONTEXT = [
  "Контекст семьи:",
  "Мы семья из 3 человек.",
  "Папа Гена, 1990 года рождения.",
  "Мама Даша, 1992 года рождения.",
  "Сын Артур, 2001 года рождения.",
  "Еще есть дедушка Дядя Леша.",
  "Мы живем в Польше.",
  "По умолчанию траты идут в злотых.",
  "Гена работает программистом как ИП. Обычно тратит на продукты, квартиру, счета, садик, бензин, обслуживание машины, отпуск, essential-вещи и налоги по ИП.",
  "Даша работает подологом как ИП. Обычно тратит на налоги, рабочие расходы, косметику, бьюти-процедуры и продукты.",
  "Иногда мы покупаем подарки друг другу, подарки Артуру и иногда ходим в рестораны.",
  "Изредка ездим в Украину, там могут быть траты в гривнах и на что-то специфическое для Украины.",
].join(" ");
const TAG_RULES = [
  "Правила интерпретации тегов:",
  "Старайся понять, к какому члену семьи относится расход или доход, и добавляй тег этого члена семьи, если связь достаточно ясна.",
  "Если связь с конкретным членом семьи неясна, не добавляй тег человека только ради предположения. Например: 'Такси 100 зл' само по себе не означает ни Гену, ни Дашу.",
  "Если запись явно связана с ребенком, детскими товарами, садиком, няней, детскими занятиями или другими детскими расходами, даже если не указано явно, что это Артур, то нужен все равно тег Артур.",
  "Если доход не указывает явно, кто его получил, то по умолчанию чаще всего это Даша, особенно если есть слова клиент, заработала сегодня, запись, услуга, подология или другой контекст работы подолога.",
  "Если доход явно связан с программированием, ИП Гены, разработкой или клиентом Гены, тогда тег Гена подходит лучше.",
  "Если неясно, доход это или расход, по умолчанию считай это расходом.",
  "Короткие бытовые записи без явных слов о получении денег обычно являются расходами. Например: 'Няня 350 зл' и 'Такси 100 злотых' это расходы.",
  "Glovo, Wolt, Uber Eats, Bolt Food и другие сервисы доставки обычно относятся к тегу Доставка.",
  "Если упомянут только сервис или бренд, старайся понять по нему тип сервиса и добавить осмысленный тег. Например сервис доставки -> Доставка, такси-сервис -> Такси.",
  "Не добавляй случайные теги, которые не следуют из смысла записи.",
].join(" ");
const INITIAL_EXPENSE_TAGS = [
  "Артур",
  "Даша",
  "Гена",
  "Дядя Леша",
  "Няня",
  "Машина",
  "Квартира",
  "Игрушки",
  "Работа",
  "Продукты",
  "Ресторан",
  "Подарки",
  "Налоги",
  "Садик",
  "Бензин",
  "Отпуск",
  "Красота",
  "Подология",
  "Счета",
  "Здоровье",
  "Развлечения",
  "Такси",
  "Медицина",
  "Образование",
  "Транспорт",
  "Доставка",
  "Одежда/Обувь",
  "Электроника",
  "Дом",
  "Ремонт",
  "Спорт",
  "Хобби",
  "Путешествия",
  "Алкоголь",
  "Подписки",
];
const INITIAL_INCOME_TAGS = [
  "Работа",
  "Даша",
  "Гена",
  "Возврат",
  "Клиент",
  "Подология",
  "Программирование",
  "Зарплата",
  "Оплата",
  "Премия",
  "Перевод",
];

let sheetsClientPromise: Promise<sheets_v4.Sheets> | null = null;
let firstSheetInfoPromise: Promise<SheetInfo> | null = null;
const undoOperations = new Map<string, UndoOperation>();

bot.start(async (ctx) => {
  await ctx.reply(
    "Отправь мне голосовое или текстовое сообщение с расходами или доходами, и я сохраню их в Google Sheets.",
  );
});

bot.on(message("voice"), async (ctx) => {
  try {
    await ctx.reply("Обрабатываю голосовое сообщение...");

    const voice = ctx.message.voice;
    const tempDir = path.join(
      process.cwd(),
      "tmp",
      "telegram-voice",
      randomUUID(),
    );
    await mkdir(tempDir, { recursive: true });

    const extension = voice.mime_type?.includes("ogg") ? "ogg" : "bin";
    const localAudioPath = path.join(tempDir, `${randomUUID()}.${extension}`);

    try {
      await downloadTelegramVoiceFile(voice.file_id, localAudioPath);

      const transcription = await transcribeAudio(localAudioPath);
      await processFinanceText(ctx, transcription);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    console.error("Voice message handling failed:", error);
    await ctx.reply(
      "Не удалось сохранить запись. Попробуй еще раз через минуту.",
    );
  }
});

bot.on(message("text"), async (ctx, next) => {
  if (ctx.message.text.startsWith("/start")) {
    await next();
    return;
  }

  try {
    await ctx.reply("Обрабатываю текстовое сообщение...");
    await processFinanceText(ctx, ctx.message.text);
  } catch (error) {
    console.error("Text message handling failed:", error);
    await ctx.reply(
      "Не удалось сохранить запись. Попробуй еще раз через минуту.",
    );
  }
});

bot.action(/^undo:([\w-]+)$/, async (ctx) => {
  const operationId = ctx.match[1];
  const operation = undoOperations.get(operationId);

  if (!operation) {
    await ctx.answerCbQuery("Эту операцию уже нельзя отменить.");
    return;
  }

  const currentUserId = ctx.from?.id;
  const currentChatId = ctx.chat?.id;

  if (currentUserId !== operation.userId || currentChatId !== operation.chatId) {
    await ctx.answerCbQuery("Эту операцию может отменить только тот, кто ее создал.");
    return;
  }

  if (Date.now() - operation.createdAt > UNDO_WINDOW_MS) {
    undoOperations.delete(operationId);
    await ctx.answerCbQuery("Время для отмены уже истекло.");
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch (error) {
      console.error("Failed to clear expired undo button:", error);
    }
    return;
  }

  try {
    await deleteSheetRows(operation.sheetId, operation.startRow, operation.endRow);
    undoOperations.delete(operationId);
    await ctx.answerCbQuery("Операция отменена.");
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.reply("Последняя операция отменена.");
  } catch (error) {
    console.error("Undo operation failed:", error);
    await ctx.answerCbQuery("Не удалось отменить операцию.");
  }
});

bot.catch(async (error, ctx) => {
  console.error("Unhandled Telegram bot error:", error);
  try {
    await ctx.reply("Произошла непредвиденная ошибка. Попробуй еще раз.");
  } catch (replyError) {
    console.error("Failed to send Telegram error reply:", replyError);
  }
});

async function downloadTelegramVoiceFile(
  fileId: string,
  destinationPath: string,
): Promise<void> {
  const fileLink = await bot.telegram.getFileLink(fileId);
  const response = await fetch(fileLink.toString());

  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download Telegram file. HTTP status: ${response.status}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  await writeFile(destinationPath, Buffer.from(arrayBuffer));
}

async function transcribeAudio(audioPath: string): Promise<string> {
  const transcription = await openai.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: "gpt-4o-mini-transcribe",
    language: DEFAULT_TRANSCRIPTION_LANGUAGE,
    prompt:
      "Это сообщение о личных финансах семьи. Ожидаются русские слова, суммы, доходы, расходы, возвраты, названия услуг, магазинов типа Жабка и Бедронка и других польских названий, членов семьи и бытовых категорий. Иногда семья ездит в отпуск в другие страны, так что можно услышать и не польские названия.",
  });

  const text = transcription.text?.trim();

  if (!text) {
    throw new Error("Speech-to-text returned an empty transcription.");
  }

  return text;
}

async function processFinanceText(
  ctx: ReplyContext,
  rawText: string,
): Promise<void> {
  const entries = await extractEntries(rawText);

  if (entries.length === 0) {
    await ctx.reply(
      "Я не нашел в сообщении ни расходов, ни доходов. Попробуй еще раз и упомяни сумму, валюту и короткое описание.",
    );
    return;
  }

  const appendResult = await appendEntriesToGoogleSheets(entries);
  const confirmationText = buildConfirmationMessage(entries);

  if (!ctx.from?.id || !ctx.chat?.id || !appendResult.rowRange) {
    await ctx.reply(confirmationText);
    return;
  }

  const operationId = randomUUID();
  const replyMessage = await ctx.reply(
    confirmationText,
    Markup.inlineKeyboard([
      Markup.button.callback("Отменить", `undo:${operationId}`),
    ]),
  );

  undoOperations.set(operationId, {
    operationId,
    userId: ctx.from.id,
    chatId: ctx.chat.id,
    sheetId: appendResult.sheetInfo.sheetId,
    startRow: appendResult.rowRange.startRow,
    endRow: appendResult.rowRange.endRow,
    createdAt: Date.now(),
    messageId: replyMessage.message_id ?? 0,
  });
}

async function extractEntries(rawText: string): Promise<Entry[]> {
  const today = formatLocalDate(new Date());
  const tableContext = await getSheetContext();

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "finance_entry_list",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            entries: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { type: "string" },
                  date: { type: "string" },
                  tags: {
                    type: "array",
                    items: { type: "string" },
                  },
                  description: { type: "string" },
                  amount: { type: "number" },
                  currency: { type: "string" },
                  raw_text: { type: "string" },
                },
                required: [
                  "type",
                  "date",
                  "tags",
                  "description",
                  "amount",
                  "currency",
                  "raw_text",
                ],
              },
            },
          },
          required: ["entries"],
        },
      },
    },
    messages: [
      {
        role: "system",
        content: [
          "Извлеки финансовые записи из текста пользователя.",
          "Вход обычно на русском языке.",
          FAMILY_CONTEXT,
          TAG_RULES,
          buildTagHistoryPrompt("расход", tableContext.expenseTagsWithDescriptions),
          buildTagHistoryPrompt("доход", tableContext.incomeTagsWithDescriptions),
          buildRecentRowsPrompt(tableContext.recentRows),
          buildOlderRowsPrompt(tableContext.sampledOlderRows),
          `Используй ${today} как опорную дату для слов вроде 'сегодня' и 'вчера'.`,
          "Верни JSON-объект с массивом entries.",
          "Все текстовые поля в результате должны быть на русском языке: tags, description и raw_text.",
          `Если валюта не указана явно, используй ${DEFAULT_CURRENCY}.`,
          "Для каждой записи верни type как 'расход' или 'доход', date в формате YYYY-MM-DD, tags как массив коротких тегов, description, amount как число, currency как строку и raw_text.",
          "Ожидай и расходы, и доходы.",
          "Примеры доходов: 'Клиент заплатил 100 злотых', 'Заработала 500 злотых', 'Получил 1000 злотых', 'Вернули 500 злотых'.",
          "Возврат денег, вернули деньги, возврат от магазина или клиента считай доходом, если это поступление денег обратно.",
          "Для расходов используй расходные теги. Для доходов используй только доходные теги или новые подходящие доходные теги.",
          "Создавай от 1 до 4 полезных тегов по смыслу записи.",
          "Теги должны быть короткими, понятными и удобными для фильтрации.",
          "Если в одной записи перечислены несколько сумм для одного и того же события, не создавай несколько одинаковых записей. Сложи суммы и верни одну запись. Например: 'Сегодня заработала 350, 500 и 1000 злотых' => одна запись с amount 1850.",
          "Если в одной фразе несколько финансовых событий, раздели их на отдельные записи.",
          "Если финансовых записей нет, верни пустой массив entries.",
        ].join(" "),
      },
      {
        role: "user",
        content: rawText,
      },
    ],
  });

  const content = completion.choices[0]?.message?.content;

  if (!content) {
    throw new Error("OpenAI did not return entry extraction content.");
  }

  const parsed = JSON.parse(content) as { entries?: unknown };

  if (!parsed.entries || !Array.isArray(parsed.entries)) {
    throw new Error("Entry extraction payload is missing the entries array.");
  }

  const entries = parsed.entries
    .map((entry) => normalizeEntry(entry, rawText))
    .filter((entry): entry is Entry => entry !== null);

  return resolveEntryTags(entries, tableContext, rawText);
}

function normalizeEntry(entry: unknown, fallbackRawText: string): Entry | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const candidate = entry as Partial<Entry>;
  const amount =
    typeof candidate.amount === "number"
      ? candidate.amount
      : Number(candidate.amount);

  if (
    !isEntryType(candidate.type) ||
    typeof candidate.date !== "string" ||
    typeof candidate.description !== "string" ||
    Number.isNaN(amount) ||
    typeof candidate.currency !== "string" ||
    !Array.isArray(candidate.tags)
  ) {
    return null;
  }

  return {
    type: candidate.type,
    date: candidate.date,
    tags: normalizeTags(candidate.tags),
    description: candidate.description.trim(),
    amount,
    currency: normalizeCurrency(candidate.currency),
    raw_text:
      typeof candidate.raw_text === "string" && candidate.raw_text.trim()
        ? candidate.raw_text.trim()
        : fallbackRawText,
  };
}

async function resolveEntryTags(
  entries: Entry[],
  tableContext: SheetContext,
  rawText: string,
): Promise<Entry[]> {
  if (entries.length === 0) {
    return entries;
  }

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "resolved_entry_tags",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            entries: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  index: { type: "number" },
                  type: { type: "string" },
                  tags: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                required: ["index", "type", "tags"],
              },
            },
          },
          required: ["entries"],
        },
      },
    },
    messages: [
      {
        role: "system",
        content: [
          "Нормализуй тип и теги финансовых записей.",
          FAMILY_CONTEXT,
          TAG_RULES,
          "Текст записей может быть на русском языке.",
          `Исходный текст: ${rawText}`,
          buildTagHistoryPrompt("расход", tableContext.expenseTagsWithDescriptions),
          buildTagHistoryPrompt("доход", tableContext.incomeTagsWithDescriptions),
          buildRecentRowsPrompt(tableContext.recentRows),
          buildOlderRowsPrompt(tableContext.sampledOlderRows),
          `Существующие расходные теги: ${tableContext.availableExpenseTags.join(", ")}.`,
          `Существующие доходные теги: ${tableContext.availableIncomeTags.join(", ")}.`,
          "Определи для каждой записи type как 'расход' или 'доход'.",
          "Для расходов переиспользуй только расходные теги, если это очевидное совпадение или явный синоним.",
          "Для доходов переиспользуй только доходные теги, если это очевидное совпадение или явный синоним.",
          "Примеры доходов: клиент заплатил, заработала, получил, возврат.",
          "Возврат денег считай доходом, если деньги пришли обратно.",
          "Если подходящих существующих тегов нет, создай новые короткие теги в рамках правильного типа.",
          "Верни от 1 до 4 итоговых тегов для каждой записи.",
          "Все теги должны быть на русском языке, короткими и удобными для фильтрации.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          entries: entries.map((entry, index) => ({
            index,
            current_type: entry.type,
            current_tags: entry.tags,
            description: entry.description,
            raw_text: entry.raw_text,
          })),
        }),
      },
    ],
  });

  const content = completion.choices[0]?.message?.content;

  if (!content) {
    return entries;
  }

  const parsed = JSON.parse(content) as {
    entries?: Array<{ index?: number; type?: string; tags?: string[] }>;
  };

  if (!parsed.entries || !Array.isArray(parsed.entries)) {
    return entries;
  }

  const resolvedByIndex = new Map<number, { type: EntryType; tags: string[] }>();

  for (const item of parsed.entries) {
    if (
      typeof item.index === "number" &&
      item.index >= 0 &&
      item.index < entries.length &&
      isEntryType(item.type) &&
      Array.isArray(item.tags)
    ) {
      const existingTags =
        item.type === "доход"
          ? tableContext.availableIncomeTags
          : tableContext.availableExpenseTags;
      resolvedByIndex.set(item.index, {
        type: item.type,
        tags: reconcileTags(item.tags, existingTags),
      });
    }
  }

  return entries.map((entry, index) => {
    const resolved = resolvedByIndex.get(index);
    if (!resolved) {
      const existingTags =
        entry.type === "доход"
          ? tableContext.availableIncomeTags
          : tableContext.availableExpenseTags;
      return {
        ...entry,
        tags: reconcileTags(entry.tags, existingTags),
      };
    }
    return {
      ...entry,
      type: resolved.type,
      tags: resolved.tags,
    };
  });
}

async function appendEntriesToGoogleSheets(entries: Entry[]): Promise<{
  rowRange: { endRow: number; startRow: number } | null;
  sheetInfo: SheetInfo;
}> {
  const sheets = await getSheetsClient();
  const sheetInfo = await getFirstSheetInfo(sheets);

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${sheetInfo.title}!A:G`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: entries.map((entry) => [
        entry.date,
        entry.type,
        formatTagsForStorage(entry.tags),
        entry.description,
        entry.amount,
        entry.currency,
        entry.raw_text,
      ]),
    },
  });

  return {
    sheetInfo,
    rowRange: parseUpdatedRange(response.data.updates?.updatedRange),
  };
}

type SheetContext = {
  availableExpenseTags: string[];
  availableIncomeTags: string[];
  expenseTagsWithDescriptions: Array<{ tag: string; descriptions: string[] }>;
  incomeTagsWithDescriptions: Array<{ tag: string; descriptions: string[] }>;
  recentRows: SheetEntryRow[];
  sampledOlderRows: SheetEntryRow[];
};

async function getSheetContext(): Promise<SheetContext> {
  const sheets = await getSheetsClient();
  const sheetInfo = await getFirstSheetInfo(sheets);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${sheetInfo.title}!A:G`,
  });

  const rows = parseSheetRows(response.data.values ?? []);
  const availableExpenseTags = Array.from(
    new Map(
      [...INITIAL_EXPENSE_TAGS, ...rows.filter((row) => row.type === "расход").flatMap((row) => row.tags)]
        .filter((value) => value.toLowerCase() !== "tags")
        .map((value) => [value.toLowerCase(), value] as const),
    ).values(),
  );
  const availableIncomeTags = Array.from(
    new Map(
      [...INITIAL_INCOME_TAGS, ...rows.filter((row) => row.type === "доход").flatMap((row) => row.tags)]
        .filter((value) => value.toLowerCase() !== "tags")
        .map((value) => [value.toLowerCase(), value] as const),
    ).values(),
  );

  return {
    availableExpenseTags,
    availableIncomeTags,
    expenseTagsWithDescriptions: buildTagDescriptionHistory(
      rows.filter((row) => row.type === "расход"),
      availableExpenseTags,
    ),
    incomeTagsWithDescriptions: buildTagDescriptionHistory(
      rows.filter((row) => row.type === "доход"),
      availableIncomeTags,
    ),
    recentRows: rows.slice(-RECENT_ROWS_LIMIT),
    sampledOlderRows: sampleOlderRows(rows, RECENT_ROWS_LIMIT, OLDER_ROWS_SAMPLE_LIMIT),
  };
}

function parseSheetRows(values: unknown[][]): SheetEntryRow[] {
  return Array.from(
    values
      .slice(1)
      .map((row) => parseSheetRow(row))
      .filter((row): row is SheetEntryRow => row !== null),
  );
}

function parseSheetRow(row: unknown[]): SheetEntryRow | null {
  const secondCell = String(row[1] ?? "").trim();
  const hasExplicitType = isEntryType(secondCell);

  const type = hasExplicitType ? secondCell : "расход";
  const tagsIndex = hasExplicitType ? 2 : 1;
  const descriptionIndex = hasExplicitType ? 3 : 2;
  const amountIndex = hasExplicitType ? 4 : 3;
  const currencyIndex = hasExplicitType ? 5 : 4;
  const rawTextIndex = hasExplicitType ? 6 : 5;

  const parsedRow: SheetEntryRow = {
    date: String(row[0] ?? "").trim(),
    type,
    tags: parseStoredTags(String(row[tagsIndex] ?? "")),
    description: String(row[descriptionIndex] ?? "").trim(),
    amount: String(row[amountIndex] ?? "").trim(),
    currency: String(row[currencyIndex] ?? "").trim(),
    raw_text: String(row[rawTextIndex] ?? "").trim(),
  };

  return parsedRow.date || parsedRow.description || parsedRow.tags.length > 0
    ? parsedRow
    : null;
}

async function getSheetsClient(): Promise<sheets_v4.Sheets> {
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      const credentials = JSON.parse(
        await readFile(credentialsPath, "utf8"),
      ) as Record<string, unknown>;

      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });

      return google.sheets({
        version: "v4",
        auth,
      });
    })().catch((error) => {
      sheetsClientPromise = null;
      throw error;
    });
  }

  return sheetsClientPromise;
}

async function getFirstSheetInfo(sheets: sheets_v4.Sheets): Promise<SheetInfo> {
  if (!firstSheetInfoPromise) {
    firstSheetInfoPromise = (async () => {
      const response = await sheets.spreadsheets.get({
        spreadsheetId: GOOGLE_SHEET_ID,
        fields: "sheets(properties(sheetId,title))",
      });

      const firstSheet = response.data.sheets?.[0]?.properties;
      const title = firstSheet?.title;
      const sheetId = firstSheet?.sheetId;

      if (!title || typeof sheetId !== "number") {
        throw new Error("Unable to determine the first sheet info.");
      }

      return {
        title,
        sheetId,
      };
    })().catch((error) => {
      firstSheetInfoPromise = null;
      throw error;
    });
  }

  return firstSheetInfoPromise;
}

function buildConfirmationMessage(entries: Entry[]): string {
  const lines = entries.map(
    (entry, index) =>
      `${index + 1}. ${entry.date} | ${entry.type} | ${entry.amount} ${entry.currency} | ${entry.description} | теги: ${formatTagsForStorage(entry.tags)}`,
  );

  const incomeCount = entries.filter((entry) => entry.type === "доход").length;
  const expenseCount = entries.filter((entry) => entry.type === "расход").length;

  return [
    `Сохранил ${entries.length} запись(ей): доходов ${incomeCount}, расходов ${expenseCount}.`,
    ...lines,
  ].join("\n");
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function normalizeTags(tags: unknown[]): string[] {
  const normalized = tags
    .map((tag) => String(tag).trim())
    .map((tag) => tag.replace(/\s+/g, " "))
    .map((tag) => tag.replace(/^#+/, ""))
    .filter(Boolean);

  const uniqueTags = Array.from(new Set(normalized)).slice(0, 4);

  return uniqueTags.length > 0 ? uniqueTags : ["Прочее"];
}

function reconcileTags(candidateTags: string[], existingTags: string[]): string[] {
  const normalizedCandidates = normalizeTags(candidateTags);

  return normalizedCandidates.map((candidateTag) => {
    const existingTag = existingTags.find(
      (tag) => tag.trim().toLowerCase() === candidateTag.toLowerCase(),
    );

    return existingTag ?? candidateTag;
  });
}

function formatTagsForStorage(tags: string[]): string {
  return normalizeTags(tags).join(", ");
}

function parseStoredTags(value: string): string[] {
  return value
    .split(/[,\n;|]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/\s+/g, " "));
}

function parseUpdatedRange(
  updatedRange: string | null | undefined,
): { endRow: number; startRow: number } | null {
  if (!updatedRange) {
    return null;
  }

  const match = updatedRange.match(/![A-Z]+(\d+):[A-Z]+(\d+)/);

  if (!match) {
    return null;
  }

  const startRow = Number(match[1]);
  const endRow = Number(match[2]);

  if (Number.isNaN(startRow) || Number.isNaN(endRow)) {
    return null;
  }

  return { startRow, endRow };
}

function buildTagDescriptionHistory(
  rows: SheetEntryRow[],
  availableTags: string[],
): Array<{ tag: string; descriptions: string[] }> {
  const descriptionsByTag = new Map<string, string[]>();

  for (const tag of availableTags) {
    descriptionsByTag.set(tag, []);
  }

  for (const row of rows) {
    for (const rowTag of row.tags) {
      const matchedTag =
        availableTags.find(
          (tag) => tag.trim().toLowerCase() === rowTag.trim().toLowerCase(),
        ) ?? rowTag;

      const descriptions = descriptionsByTag.get(matchedTag) ?? [];
      if (row.description && !descriptions.includes(row.description)) {
        descriptions.push(row.description);
      }
      descriptionsByTag.set(matchedTag, descriptions);
    }
  }

  return availableTags.map((tag) => ({
    tag,
    descriptions: (descriptionsByTag.get(tag) ?? []).slice(-TAG_EXAMPLES_PER_TAG),
  }));
}

function buildTagHistoryPrompt(
  type: EntryType,
  tagsWithDescriptions: Array<{ tag: string; descriptions: string[] }>,
): string {
  if (tagsWithDescriptions.length === 0) {
    return `История тегов для типа ${type} пока пустая.`;
  }

  const lines = tagsWithDescriptions.map(({ tag, descriptions }) => {
    if (descriptions.length === 0) {
      return `${tag}: без примеров описаний`;
    }

    return `${tag}: ${descriptions.join(" | ")}`;
  });

  return `Известные теги для типа ${type} и связанные с ними описания: ${lines.join("; ")}.`;
}

function buildRecentRowsPrompt(rows: SheetEntryRow[]): string {
  if (rows.length === 0) {
    return "Последних записей в таблице пока нет.";
  }

  const lines = rows.map(
    (row) =>
      `${row.date} | ${row.type} | ${formatTagsForStorage(row.tags)} | ${row.description} | ${row.amount} ${row.currency} | ${row.raw_text}`,
  );

  return `Последние записи из таблицы: ${lines.join(" ; ")}.`;
}

function buildOlderRowsPrompt(rows: SheetEntryRow[]): string {
  if (rows.length === 0) {
    return "Дополнительных старых примеров из таблицы пока нет.";
  }

  const lines = rows.map(
    (row) =>
      `${row.date} | ${row.type} | ${formatTagsForStorage(row.tags)} | ${row.description} | ${row.amount} ${row.currency} | ${row.raw_text}`,
  );

  return `Более старые распределенные примеры из таблицы: ${lines.join(" ; ")}.`;
}

function sampleOlderRows(
  rows: SheetEntryRow[],
  recentRowsLimit: number,
  sampleLimit: number,
): SheetEntryRow[] {
  const olderRows = rows.slice(0, Math.max(0, rows.length - recentRowsLimit));

  if (olderRows.length <= sampleLimit) {
    return olderRows;
  }

  const sampled: SheetEntryRow[] = [];
  const lastIndex = olderRows.length - 1;

  for (let i = 0; i < sampleLimit; i += 1) {
    const position =
      sampleLimit === 1
        ? Math.floor(lastIndex / 2)
        : Math.round((i * lastIndex) / (sampleLimit - 1));
    sampled.push(olderRows[position]);
  }

  return sampled.filter(
    (row, index, array) =>
      array.findIndex(
        (candidate) =>
          candidate.date === row.date &&
          candidate.type === row.type &&
          candidate.description === row.description &&
          candidate.amount === row.amount &&
          candidate.currency === row.currency &&
          candidate.raw_text === row.raw_text,
      ) === index,
  );
}

async function deleteSheetRows(
  sheetId: number,
  startRow: number,
  endRow: number,
): Promise<void> {
  const sheets = await getSheetsClient();

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: GOOGLE_SHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: startRow - 1,
              endIndex: endRow,
            },
          },
        },
      ],
    },
  });
}

function isEntryType(value: unknown): value is EntryType {
  return value === "расход" || value === "доход";
}

function normalizeCurrency(currency: string): string {
  const value = currency.trim();
  const normalized = value.toLowerCase();

  if (!normalized) {
    return DEFAULT_CURRENCY;
  }

  if (
    normalized === "zl" ||
    normalized === "pln" ||
    normalized === "зл" ||
    normalized === "злотый" ||
    normalized === "злотых" ||
    normalized === "злотые"
  ) {
    return "PLN";
  }

  if (
    normalized === "eur" ||
    normalized === "евро"
  ) {
    return "EUR";
  }

  if (
    normalized === "usd" ||
    normalized === "доллар" ||
    normalized === "доллара" ||
    normalized === "долларов"
  ) {
    return "USD";
  }

  return value.toUpperCase();
}

async function bootstrap(): Promise<void> {
  await bot.launch();
  console.log("Telegram expense bot is running.");
}

bootstrap().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exit(1);
});

process.once("SIGINT", () => {
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
});
