// Playwright 只在端到端测试里按需加载，不是项目依赖。这里给出测试用到的最小类型，
// 让 `npm run typecheck` 在没有安装 Playwright 的机器上也能通过。
declare module 'playwright' {
  export interface Locator {
    first(): Locator;
    isVisible(): Promise<boolean>;
    isDisabled(): Promise<boolean>;
    innerText(): Promise<string>;
    click(): Promise<void>;
    count(): Promise<number>;
  }
  export interface Download { path(): Promise<string | null> }
  export interface ConsoleMessage { type(): string; text(): string }
  export interface Response { status(): number; url(): string }
  export interface Page {
    goto(url: string): Promise<unknown>;
    reload(): Promise<unknown>;
    url(): string;
    content(): Promise<string>;
    click(selector: string): Promise<void>;
    fill(selector: string, value: string): Promise<void>;
    selectOption(selector: string, value: string): Promise<unknown>;
    setInputFiles(selector: string, files: string | { name: string; mimeType: string; buffer: Buffer }): Promise<void>;
    waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
    waitForURL(url: RegExp): Promise<void>;
    waitForTimeout(ms: number): Promise<void>;
    waitForEvent(event: 'download'): Promise<Download>;
    locator(selector: string): Locator;
    screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
    evaluate<T>(fn: () => T): Promise<T>;
    keyboard: { press(key: string): Promise<void> };
    on(event: 'console', cb: (m: ConsoleMessage) => void): void;
    on(event: 'pageerror', cb: (e: Error) => void): void;
    on(event: 'response', cb: (r: Response) => void): void;
  }
  export interface BrowserContext { newPage(): Promise<Page> }
  export interface Browser {
    newContext(options?: Record<string, unknown>): Promise<BrowserContext>;
    close(): Promise<void>;
  }
  export const chromium: { launch(options?: Record<string, unknown>): Promise<Browser> };
}
