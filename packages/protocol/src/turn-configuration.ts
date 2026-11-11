import { z } from "zod";
import { SessionConfigurationValuesSchema } from "./session-configuration.js";

/** Exact native command values; display model IDs and aliases are not interchangeable. */
export const ModelSelectionValuesSchema = SessionConfigurationValuesSchema.pick({ model: true, thinking: true });
export type ModelSelectionValues = z.infer<typeof ModelSelectionValuesSchema>;

/** S52 / SC76: an execution fact belongs to one native turn, independently of selection. */
export const TurnConfigurationSchema = z.strictObject({
  turnId: z.string().min(1).max(256),
  requestIndex: z.number().int().nonnegative().optional(),
  model: z.strictObject({
    provider: z.string().min(1).max(128), id: z.string().min(1).max(256),
    name: z.string().min(1).max(256).optional(),
  }).optional(),
  // Missing means unknown; null is an observed native default/no explicit effort.
  thinkingLevel: z.string().min(1).max(64).nullable().optional(),
});
export type TurnConfiguration = z.infer<typeof TurnConfigurationSchema>;
