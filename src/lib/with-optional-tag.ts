import { Schema, SchemaAST, Struct } from "effect"

// Same schema, but decoding input may omit `_tag`; the schema's own tag fills it in. Decode only.
// Struct.assign, not `({ ...fields, _tag })`: with generic Fields the spread types the decoded _tag as never.
export const withOptionalTag = <Tag extends SchemaAST.LiteralValue, Fields extends Schema.Struct.Fields>(
  schema: Schema.TaggedStruct<Tag, Fields>,
) => schema.mapFields(Struct.assign({ _tag: Schema.tagDefaultOmit(schema.fields._tag.schema.literal) }))
