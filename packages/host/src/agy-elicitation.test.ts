import { describe, expect, it } from "vitest";
import { agyElicitation } from "./agy-elicitation.js";

describe("AGY ACP question mapping", () => {
  // AGY-12: make native field identity and enum values authoritative, not HTML/URLs or reply order.
  it("accepts only the offered form and typed values", () => {
    const form = agyElicitation({ mode: "form", requestedSchema: { type: "object", required: ["colour", "name", "confirm"], properties: {
      colour: { type: "string", enum: ["red", "blue"] }, name: { type: "string", minLength: 1, maxLength: 10 }, confirm: { type: "boolean" },
    } } })!;
    const [colour, name, confirm] = form.questions;
    const answers = [{ id: confirm!.id, values: [confirm!.options[1]!.value] }, { id: colour!.id, values: [colour!.options[1]!.value] }, { id: name!.id, values: [], other: "test" }];
    expect(form.decode({ kind: "questionnaire", answers })).toEqual({ colour: "blue", name: "test", confirm: false });
    expect(form.decode({ kind: "questionnaire", answers: [...answers.slice(0, 2), { id: name!.id, values: [], other: "" }] })).toBeUndefined();
    expect(form.decode({ kind: "questionnaire", answers: [{ id: confirm!.id, values: ["false"] }, ...answers.slice(1)] })).toBeUndefined();
    expect(agyElicitation({ mode: "url", url: "https://example.test" })).toBeUndefined();
    expect(agyElicitation({ mode: "form", requestedSchema: { type: "object", properties: { secret: { type: "string", format: "password" } }, required: ["secret"] } })).toBeUndefined();
  });
});
