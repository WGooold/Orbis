import { randomUUID } from "node:crypto";
import type { InteractionResponse, QuestionnaireQuestion } from "@orbis/protocol";
import { record, type JsonObject } from "./acp-client.js";

type Field = {
  key: string; question: QuestionnaireQuestion; choices?: ReadonlyMap<string, string | boolean>;
  minimum?: number; maximum?: number;
};

/** Map only the flat, required boolean/text/enum subset; don't prompt for URLs or secrets. */
export function agyElicitation(params: JsonObject): { questions: QuestionnaireQuestion[]; decode: (response: InteractionResponse) => JsonObject | undefined } | undefined {
  if (params.mode !== "form") return undefined;
  const schema = record(params.requestedSchema);
  const properties = Object.entries(record(schema.properties));
  const required = schema.required;
  if (schema.type !== "object" || !Array.isArray(required) || properties.length < 1 || properties.length > 16
    || properties.length !== required.length || !properties.every(([key]) => required.includes(key))
    || Object.keys(schema).some(key => !["type", "properties", "required", "title", "description", "additionalProperties", "_meta"].includes(key))) return undefined;
  const fields: Field[] = [];
  for (const [key, value] of properties) {
    if (!/^[\w.-]{1,128}$/u.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) return undefined;
    const raw = record(value);
    if (Object.keys(raw).some(name => !["type", "title", "description", "enum", "minLength", "maxLength", "default", "_meta"].includes(name))) return undefined;
    const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 100) : key;
    const prompt = typeof raw.description === "string" && raw.description.trim() ? raw.description.trim().slice(0, 4000) : title;
    const question: QuestionnaireQuestion = { id: randomUUID(), header: title.slice(0, 100), question: prompt, options: [] };
    const nativeValues = raw.type === "boolean" ? [true, false] : Array.isArray(raw.enum) ? raw.enum : undefined;
    if (nativeValues) {
      if (raw.type !== "boolean" && (raw.type !== "string" || !nativeValues.length || nativeValues.length > 32 || !nativeValues.every(item => typeof item === "string" && item.length > 0 && item.length <= 512))) return undefined;
      if (raw.minLength !== undefined || raw.maxLength !== undefined || nativeValues.length !== new Set(nativeValues).size) return undefined;
      const choices = new Map<string, string | boolean>();
      for (const value of nativeValues as (string | boolean)[]) {
        const id = randomUUID();
        choices.set(id, value); question.options.push({ value: id, label: String(value) });
      }
      fields.push({ key, question, choices });
      continue;
    }
    if (raw.type !== "string" || raw.enum !== undefined) return undefined;
    const minimum = raw.minLength ?? 0, maximum = raw.maxLength ?? 4000;
    if (typeof minimum !== "number" || typeof maximum !== "number" || !Number.isInteger(minimum) || !Number.isInteger(maximum)
      || minimum < 0 || maximum < Math.max(1, minimum) || maximum > 4000) return undefined;
    fields.push({ key, question: { ...question, allowOther: true }, minimum, maximum });
  }
  return { questions: fields.map(field => field.question), decode(response) {
    if (response.kind !== "questionnaire" || response.answers.length !== fields.length) return undefined;
    const content: JsonObject = {};
    for (const field of fields) {
      const answer = response.answers.find(item => item.id === field.question.id);
      if (!answer) return undefined;
      if (field.choices) {
        const value = answer.values.length === 1 ? field.choices.get(answer.values[0]!) : undefined;
        if (value === undefined || answer.other !== undefined) return undefined;
        content[field.key] = value;
      } else {
        const value = answer.other;
        if (answer.values.length || value === undefined || [...value].length < field.minimum! || [...value].length > field.maximum!) return undefined;
        content[field.key] = value;
      }
    }
    return content;
  } };
}
