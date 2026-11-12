import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

class CopyButton extends EventTarget {
  hidden = true;
  disabled = false;
  textContent = "Copy";
  readonly previousElementSibling = {
    textContent: "npm install -g @hugolopes45/lmsk",
  };
  readonly attributes = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  click(): void {
    if (!this.disabled) this.dispatchEvent(new Event("click"));
  }
}

function page(writeText: (text: string) => Promise<void>) {
  const html = readFileSync(
    new URL("../docs/index.html", import.meta.url),
    "utf8",
  );
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(
    -1,
  )?.[1];
  if (script === undefined)
    throw new Error("The page has no interaction script");
  const button = new CopyButton();
  const status = { textContent: "" };
  runInNewContext(script, {
    document: {
      documentElement: { classList: { contains: () => false } },
      getElementById: () => status,
      querySelectorAll: () => [button],
    },
    navigator: { clipboard: { writeText } },
    setTimeout,
    clearTimeout,
  });
  return { button, status };
}

afterEach(() => vi.useRealTimers());

describe("documentation copy feedback", () => {
  it.each(["success", "failure"])(
    "allows only one pending copy and restores the button after %s",
    async (outcome) => {
      vi.useFakeTimers();
      let finish = (): void => undefined;
      const write = vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            finish = () =>
              outcome === "success"
                ? resolve()
                : reject(new Error("Clipboard denied"));
          }),
      );
      const { button, status } = page(write);
      button.click();
      expect(button.disabled).toBe(true);
      button.click();
      expect(write).toHaveBeenCalledTimes(1);
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe(
        outcome === "success" ? "Copied" : "Copy failed",
      );
      expect(status.textContent).toBe(
        outcome === "success"
          ? "Copied to the clipboard."
          : "Copy failed. Select the text and copy it.",
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(button.textContent).toBe("Copy");
    },
  );

  it("keeps new feedback for two seconds after a second copy", async () => {
    vi.useFakeTimers();
    const { button, status } = page(async () => undefined);
    button.click();
    await vi.advanceTimersByTimeAsync(1900);
    expect(button.textContent).toBe("Copied");
    button.click();
    await vi.advanceTimersByTimeAsync(100);
    expect(button.textContent).toBe("Copied");
    expect(status.textContent).toBe("Copied to the clipboard.");
    await vi.advanceTimersByTimeAsync(1900);
    expect(button.textContent).toBe("Copy");
  });
});
