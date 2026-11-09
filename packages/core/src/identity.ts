import { spawnSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import type { Rule } from "./config.ts";

/**
 * The values of a global git key, also from its included files. Only the global level: a repository
 * config is project input, which is untrusted. A missing git or a failed read is no value, so masking still runs.
 */
function gitGlobal(key: string): string[] {
  const result = spawnSync(
    "git",
    ["config", "--global", "--includes", "--get-all", key],
    {
      encoding: "utf8",
    },
  );
  return result.status === 0 ? result.stdout.split("\n") : [];
}

/** No user name when the uid has no passwd entry, as in a container run with an arbitrary uid. */
function userName(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

export const IDENTITY_RULE_ID = "local-identity";

/**
 * A literal rule for the user name, the short host name, and the global git user name and email.
 * The model then sees fakes in paths and text. A value that is a common word, such as a short
 * user name, is masked wherever it occurs as a word. The account name in a GitHub noreply email, such
 * as `ana-dev` in `12345+ana-dev@users.noreply.github.com`, occurs in remote URLs before the email.
 * A one-character value identifies no one, and every request holds that character.
 */
export function localIdentityRules(): Rule[] {
  const emails = gitGlobal("user.email");
  const values = [
    userName(),
    hostname().split(".")[0],
    ...gitGlobal("user.name"),
    ...emails,
    ...emails.map(
      (email) =>
        /^(?:\d+\+)?(.+)@users\.noreply\.github\.com$/.exec(email)?.[1],
    ),
  ].flatMap((value) => (value && value.length > 1 ? [value] : []));
  return values.length === 0
    ? []
    : [
        {
          id: IDENTITY_RULE_ID,
          type: "literal",
          enabled: true,
          strategy: "shape",
          values,
        },
      ];
}
