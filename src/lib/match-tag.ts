// Exhaustive dispatch on `_tag` whose result type follows the input's tag.
// Match.valueTags returns the union of all branches; this returns Out[Tag], so a generic caller needs no cast.
type Tagged = { readonly _tag: string }

export type MemberWithTag<U extends Tagged, Tag extends U["_tag"]> = Extract<U, { readonly _tag: Tag }>

type HandlersByTag<U extends Tagged, Out> = { readonly [Tag in keyof Out]: (value: MemberWithTag<U, Tag & U["_tag"]>) => Out[Tag] }

export const matchTag = <U extends Tagged>() =>
  <Out extends { readonly [Tag in U["_tag"]]: unknown }>(
    handlers: HandlersByTag<U, Out> & { readonly [Tag in Exclude<keyof Out, U["_tag"]>]: never },
  ) => {
    // Indexing the mapped type with a generic Tag keeps value and result correlated (TypeScript #47109).
    const handlerByTag: HandlersByTag<U, Out> = handlers
    return <Tag extends U["_tag"]>(value: MemberWithTag<U, Tag>): Out[Tag] => handlerByTag[value._tag](value)
  }
