export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../schema"

export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Model extends Schema.Class<Model>("ConfigV2.Compaction.Model")({
  token_threshold: PositiveInt.pipe(Schema.optional),
  context_threshold: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1)).pipe(
    Schema.optional,
  ),
  min_messages: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  auto: Schema.Boolean.pipe(Schema.optional),
  prune: Schema.Boolean.pipe(Schema.optional),
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
  token_threshold: PositiveInt.pipe(Schema.optional),
  context_threshold: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1)).pipe(
    Schema.optional,
  ),
  min_messages: NonNegativeInt.pipe(Schema.optional),
  models: Schema.Record(Schema.String, Model).pipe(Schema.optional),
}) {}
