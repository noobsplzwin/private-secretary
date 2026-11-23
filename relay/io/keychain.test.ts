import { describe, it, expect } from "vitest";
import {
  KeychainEntryMissing,
  deleteSecret,
  getJSON,
  getSecret,
  hasSecret,
  setJSON,
  setSecret,
  type SecurityResult,
  type SecurityRunner,
} from "./keychain.js";

// Tests use an injected fake runner — never touches the real Keychain.
function fakeKeychain(): {
  runner: SecurityRunner;
  store: Map<string, string>;
  calls: string[][];
} {
  const store = new Map<string, string>();
  const calls: string[][] = [];
  const runner: SecurityRunner = async (args): Promise<SecurityResult> => {
    calls.push([...args]);
    const cmd = args[0];
    if (cmd === "find-generic-password") {
      const s = args[args.indexOf("-s") + 1];
      const a = args[args.indexOf("-a") + 1];
      const v = store.get(`${s}|${a}`);
      if (v === undefined) {
        const err = Object.assign(new Error("security: missing"), {
          code: 44,
          stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
        });
        throw err;
      }
      // security adds a trailing newline to its -w output — emulate it
      return { stdout: v + "\n", stderr: "" };
    }
    if (cmd === "add-generic-password") {
      const s = args[args.indexOf("-s") + 1];
      const a = args[args.indexOf("-a") + 1];
      const v = args[args.indexOf("-w") + 1];
      store.set(`${s}|${a}`, v!);
      return { stdout: "", stderr: "" };
    }
    if (cmd === "delete-generic-password") {
      const s = args[args.indexOf("-s") + 1];
      const a = args[args.indexOf("-a") + 1];
      const key = `${s}|${a}`;
      if (!store.has(key)) {
        const err = Object.assign(new Error("security: missing"), {
          code: 44,
          stderr: "could not be found",
        });
        throw err;
      }
      store.delete(key);
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unhandled fake security cmd: ${cmd}`);
  };
  return { runner, store, calls };
}

describe("getSecret / setSecret", () => {
  it("roundtrips a value", async () => {
    const { runner } = fakeKeychain();
    await setSecret("svc", "acc", "shhh", { runner });
    expect(await getSecret("svc", "acc", { runner })).toBe("shhh");
  });

  it("strips the trailing newline that `security -w` appends, preserves internal newlines", async () => {
    const { runner } = fakeKeychain();
    const value = "line1\nline2\nline3";
    await setSecret("svc", "acc", value, { runner });
    expect(await getSecret("svc", "acc", { runner })).toBe(value);
  });

  it("getSecret throws KeychainEntryMissing on a missing entry (distinct from generic Error)", async () => {
    const { runner } = fakeKeychain();
    await expect(getSecret("svc", "nope", { runner })).rejects.toBeInstanceOf(
      KeychainEntryMissing,
    );
  });

  // 2026-11: execFile's "Command failed: <argv>" put a Google refresh token in
  // secretary.err.log on every failed write.
  it("a failed write never carries the secret in its error", async () => {
    const secret = '{"refresh_token":"1//04-very-secret"}';
    const runner = async () => {
      throw Object.assign(new Error(`Command failed: security add-generic-password -w ${secret}`), {
        code: 45,
        stderr: `security: SecKeychainItemModifyAttributesAndData: User interaction is not allowed. ${secret}`,
      });
    };
    const err = await setSecret("svc", "acc", secret, { runner }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain("very-secret");
    expect((err as Error).message).toContain("User interaction is not allowed");
    expect((err as Error).message).toContain("exit 45");
  });

  it("setSecret upserts — re-running with a new value overwrites (the `-U` flag)", async () => {
    const { runner, calls } = fakeKeychain();
    await setSecret("svc", "acc", "v1", { runner });
    await setSecret("svc", "acc", "v2", { runner });
    expect(await getSecret("svc", "acc", { runner })).toBe("v2");
    // Both add-generic-password calls included -U.
    expect(calls.filter((c) => c[0] === "add-generic-password").every((c) => c.includes("-U"))).toBe(true);
  });

  it("passes service/account/value as separate exec args (no shell interpolation)", async () => {
    const { runner, calls } = fakeKeychain();
    await setSecret("svc; rm -rf /", "acc with spaces", "weird value", { runner });
    const addCall = calls.find((c) => c[0] === "add-generic-password")!;
    // The dangerous string is preserved verbatim as one arg — never interpreted as shell.
    expect(addCall).toContain("svc; rm -rf /");
    expect(addCall).toContain("acc with spaces");
  });
});

describe("deleteSecret", () => {
  it("removes an entry", async () => {
    const { runner } = fakeKeychain();
    await setSecret("svc", "acc", "v", { runner });
    await deleteSecret("svc", "acc", { runner });
    expect(await hasSecret("svc", "acc", { runner })).toBe(false);
  });

  it("throws KeychainEntryMissing when the entry doesn't exist", async () => {
    const { runner } = fakeKeychain();
    await expect(deleteSecret("svc", "nope", { runner })).rejects.toBeInstanceOf(
      KeychainEntryMissing,
    );
  });
});

describe("hasSecret", () => {
  it("true when present, false when missing — never throws on missing", async () => {
    const { runner } = fakeKeychain();
    expect(await hasSecret("svc", "nope", { runner })).toBe(false);
    await setSecret("svc", "acc", "v", { runner });
    expect(await hasSecret("svc", "acc", { runner })).toBe(true);
  });
});

describe("getJSON / setJSON", () => {
  it("roundtrips a JSON object", async () => {
    const { runner } = fakeKeychain();
    const obj = { client_id: "abc", scopes: ["a", "b"], nested: { n: 1 } };
    await setJSON("svc", "acc", obj, { runner });
    expect(await getJSON("svc", "acc", { runner })).toEqual(obj);
  });

  it("typed retrieval — caller can specify the shape", async () => {
    const { runner } = fakeKeychain();
    interface Cfg {
      client_id: string;
      n: number;
    }
    await setJSON("svc", "acc", { client_id: "x", n: 7 }, { runner });
    const got = await getJSON<Cfg>("svc", "acc", { runner });
    expect(got.client_id).toBe("x");
    expect(got.n).toBe(7);
  });

  it("missing entry surfaces KeychainEntryMissing (not a JSON parse error)", async () => {
    const { runner } = fakeKeychain();
    await expect(getJSON("svc", "nope", { runner })).rejects.toBeInstanceOf(
      KeychainEntryMissing,
    );
  });
});
