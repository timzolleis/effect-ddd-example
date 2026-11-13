import { Result } from "effect"

type RuleError<Rule> = Rule extends (input: never) => Result.Result<void, infer Error> ? Error : never

// The first rejection wins.
export const checkRules = <Input, const Rules extends ReadonlyArray<(input: NoInfer<Input>) => Result.Result<void, unknown>>>(
  rules: Rules,
  input: Input,
): Result.Result<void, RuleError<Rules[number]>> => {
  for (const rule of rules) {
    const ruleResult = rule(input)
    // Cast: the failure holds the error of this rule, one member of RuleError<Rules[number]>; the loop variable lost which.
    if (Result.isFailure(ruleResult)) return ruleResult as Result.Result<void, RuleError<Rules[number]>>
  }
  return Result.succeed(undefined)
}
