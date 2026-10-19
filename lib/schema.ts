// Tiny Standard Schema v1 validators, enough for the plugin's settings and
// its one RPC method, so the plugin doesn't ship a validation library.

export interface Schema<T> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => { value: T; issues?: undefined } | { issues: { message: string }[] };
    readonly types?: { readonly input: T; readonly output: T };
  };
}

/** A schema from a check that returns an error message, or null when `value` is a valid T. */
export function schema<T>(check: (value: unknown) => string | null): Schema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "runnable-blocks",
      validate(value) {
        const message = check(value);
        return message === null ? { value: value as T } : { issues: [{ message }] };
      },
    },
  };
}

/** A string schema with an extra check on the string. */
export function stringSchema(check: (value: string) => string | null = () => null): Schema<string> {
  return schema<string>((value) => (typeof value === "string" ? check(value) : "Expected text."));
}
