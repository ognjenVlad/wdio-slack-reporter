import {
  Block,
  ChatPostMessageArguments,
  FilesUploadArguments,
  KnownBlock,
  WebAPICallResult,
  WebClient,
} from '@slack/web-api';
import getLogger from '@wdio/logger';
import WDIOReporter, {
  HookStats,
  RunnerStats,
  SuiteStats,
  TestStats,
} from '@wdio/reporter';
import { Capabilities } from '@wdio/types';
import util from 'util';
import {
  DEFAULT_COLOR,
  DEFAULT_INDENT,
  EMOJI_SYMBOLS,
  FAILED_COLOR,
  ERROR_MESSAGES,
  EVENTS,
  SLACK_REQUEST_TYPE,
  SUCCESS_COLOR,
  TEST_TYPES,
  FEATURE_FAILED,
  FEATURE_PASSED
} from './constants';
import {
  SlackRequestType,
  SlackReporterOptions,
  EmojiSymbols,
  StateCount,
  FeatureOutput,
} from './types';

const log = getLogger('@moroo/wdio-slack-reporter');

class SlackReporter extends WDIOReporter {
  private static resultsUrl?: string;
  private _slackRequestQueue: SlackRequestType[] = [];
  private _lastSlackWebAPICallResult?: WebAPICallResult;
  private _pendingSlackRequestCount = 0;
  private _stateCounts: StateCount = {
    passed: 0,
    failed: 0,
    skipped: 0,
  };
  private _client?: WebClient;
  private _channel?: string;
  private _symbols: EmojiSymbols;
  private _title?: string;
  private _notifyTestStartMessage: boolean = true;
  private _username: string;
  private _env: string;
  private _notifyTestFinishMessage: boolean = true;
  private _uploadScreenshotOfFailedCase: boolean = true;
  private _isSynchronizing: boolean = false;
  private _interval: NodeJS.Timeout;
  private _hasRunnerEnd = false;
  private _suites = Array<SuiteStats>();
  private _suiteIndents: Record<string, number> = {};
  private _currentFeature?: SuiteStats;
  private _currentScenario: SuiteStats;
  private _runnerStats: RunnerStats;
  private _screenshotBuffers?: Object = {};
  payload: FeatureOutput;

  constructor(options: SlackReporterOptions) {
    super(Object.assign({ stdout: true }, options));

    if (!options.slackOptions) {
      log.error(ERROR_MESSAGES.UNDEFINED_SLACK_OPTION);
      log.debug(options.slackOptions);
      throw new Error(ERROR_MESSAGES.UNDEFINED_SLACK_OPTION);
    }
    if (options.slackOptions.type === 'web-api') {
      this._client = new WebClient(options.slackOptions.slackBotToken);
      log.info('Created Slack Web API Client Instance.');
      log.debug('Slack Web API Client', {
        token: options.slackOptions.slackBotToken,
        channel: options.slackOptions.channel,
      });
      this._channel = options.slackOptions.channel;
    }
    this._symbols = {
      passed: options.emojiSymbols?.passed || EMOJI_SYMBOLS.PASSED,
      skipped: options.emojiSymbols?.skipped || EMOJI_SYMBOLS.SKIPPED,
      failed: options.emojiSymbols?.failed || EMOJI_SYMBOLS.FAILED,
      pending: options.emojiSymbols?.pending || EMOJI_SYMBOLS.PENDING,
      start: options.emojiSymbols?.start || EMOJI_SYMBOLS.ROKET,
      watch: options.emojiSymbols?.watch || EMOJI_SYMBOLS.STOPWATCH,
    };
    this._title = options.title;
    this._username = options.slackOptions.username;
    this._env = options.slackOptions.env;
    if (options.resultsUrl !== undefined) {
      SlackReporter.setResultsUrl(options.resultsUrl);
    }

    if (options.notifyTestStartMessage !== undefined) {
      this._notifyTestStartMessage = options.notifyTestStartMessage;
    }

    if (options.notifyTestFinishMessage !== undefined) {
      this._notifyTestFinishMessage = options.notifyTestFinishMessage;
    }

    if (options.slackOptions.uploadScreenshotOfFailedCase !== undefined) {
      this._uploadScreenshotOfFailedCase =
        options.slackOptions.uploadScreenshotOfFailedCase;
    }

    this._interval = global.setInterval(this.sync.bind(this), 100);

    process.on(EVENTS.POST_MESSAGE, this.postMessage.bind(this));
    process.on(EVENTS.SCREENSHOT, this.uploadFailedTestScreenshot.bind(this));
  }

  static getResultsUrl(): string | undefined {
    return SlackReporter.resultsUrl;
  }
  static setResultsUrl(url: string | undefined): void {
    SlackReporter.resultsUrl = url;
  }
  /**
   * Post message from Slack web-api
   * @param  {ChatPostMessageArguments} payload Parameters used by Slack web-api
   * @return {Promise<WebAPICallResult>}
   */
  static postMessage(
    payload: ChatPostMessageArguments
  ): Promise<WebAPICallResult> {
    return new Promise((resolve, reject) => {
      process.emit(EVENTS.POST_MESSAGE, payload);
      process.once(EVENTS.RESULT, ({ result, error }) => {
        if (result) {
          resolve(result as WebAPICallResult);
        }
        reject(error);
      });
    });
  }
  /**
   * Upload failed test scrteenshot
   * @param  {WebdriverIO.Browser} browser Parameters used by WebdriverIO.Browser
   * @param  {{page: Page, options: ScreenshotOptions}} puppeteer Parameters used by Puppeteer
   * @return {Promise<Buffer>}
   */
  static uploadFailedTestScreenshot(step, data: string | Buffer): void {
    let buffer: Buffer;
    if (typeof data === 'string') {
      buffer = Buffer.from(data, 'base64');
    } else {
      buffer = data;
    }
    process.emit(EVENTS.SCREENSHOT, step, buffer);
  }

  private async postMessage(
    payload: ChatPostMessageArguments
  ): Promise<WebAPICallResult> {
    if (this._client) {
      try {
        log.debug('COMMAND', `postMessage(${payload})`);
        this._pendingSlackRequestCount++;
        const result = await this._client.chat.postMessage(payload);
        log.debug('RESULT', util.inspect(result));
        process.emit(EVENTS.RESULT, { result, error: undefined });
        return result;
      } catch (error) {
        log.error(error);
        process.emit(EVENTS.RESULT, { result: undefined, error });
        throw error;
      } finally {
        this._pendingSlackRequestCount--;
      }
    }

    log.error(ERROR_MESSAGES.NOT_USING_WEB_API);
    throw new Error(ERROR_MESSAGES.NOT_USING_WEB_API);
  }

  get isSynchronised(): boolean {
    return (
      this._pendingSlackRequestCount === 0 && this._isSynchronizing === false
    );
  }

  private async sync(): Promise<void> {
    if (
      this._hasRunnerEnd &&
      this._slackRequestQueue.length === 0 &&
      this._pendingSlackRequestCount === 0
    ) {
      clearInterval(this._interval);
    }
    if (
      this._isSynchronizing ||
      this._slackRequestQueue.length === 0 ||
      this._pendingSlackRequestCount > 0
    ) {
      return;
    }

    try {
      this._isSynchronizing = true;
      log.info('Start Synchronising...');
      await this.next();
    } catch (error) {
      log.error(error);
      throw error;
    } finally {
      this._isSynchronizing = false;
      log.info('End Synchronising!!!');
    }
  }

  private async next() {
    const request = this._slackRequestQueue.shift();
    let result: WebAPICallResult;

    log.info('POST', `Slack Request ${request?.type}`);
    log.debug('DATA', util.inspect(request?.payload));
    if (request) {
      try {
        this._pendingSlackRequestCount++;

        switch (request.type) {
          case SLACK_REQUEST_TYPE.WEB_API_POST_MESSAGE: {
            if (this._client) {
              result = await this._client.chat.postMessage({
                ...request.payload,
                thread_ts: request.isDetailResult
                  ? (this._lastSlackWebAPICallResult?.ts as string)
                  : undefined,
              });
              this._lastSlackWebAPICallResult = request.isDetailResult ? this._lastSlackWebAPICallResult : result
              log.debug('RESULT', util.inspect(result))
            }
            break;
          }
          case SLACK_REQUEST_TYPE.WEB_API_UPLOAD: {
            if (this._client) {
              result = await this._client.files.upload({
                ...request.payload,
                thread_ts: this._lastSlackWebAPICallResult?.ts as string,
              });
            }
            break;
          }
        }
      } catch (error) {
        log.error(error);
      } finally {
        this._pendingSlackRequestCount--;
      }

      if (this._slackRequestQueue.length > 0) {
        await this.next();
      }
    }
  }

  private convertErrorStack(stack: string): string {
    return stack.replace(
      // eslint-disable-next-line no-control-regex
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
      ''
    );
  }
  private getEnviromentCombo(
    capability: Capabilities.RemoteCapability,
    isMultiremote = false
  ): string {
    let output = '';
    const capabilities: Capabilities.RemoteCapability =
      ((capability as Capabilities.W3CCapabilities)
        .alwaysMatch as Capabilities.DesiredCapabilities) ||
      (capability as Capabilities.DesiredCapabilities);
    const drivers: {
      driverName?: string;
      capability: Capabilities.RemoteCapability;
    }[] = [];

    if (isMultiremote) {
      output += '*MultiRemote*: \n';

      Object.keys(capabilities).forEach((key) => {
        drivers.push({
          driverName: key,
          capability: (capabilities as Capabilities.MultiRemoteCapabilities)[
            key
          ],
        });
      });
    } else {
      drivers.push({
        capability: capabilities,
      });
    }

    drivers.forEach(({ driverName, capability }, index, array) => {
      const isLastIndex = array.length - 1 === index;
      let env = '';
      const caps =
        ((capability as Capabilities.W3CCapabilities)
          .alwaysMatch as Capabilities.DesiredCapabilities) ||
        (capability as Capabilities.DesiredCapabilities);
      const device = caps.deviceName;
      const browser = caps.browserName || caps.browser;
      const version =
        caps.browserVersion ||
        caps.version ||
        caps.platformVersion ||
        caps.browser_version;
      const platform =
        caps.platformName ||
        caps.platform ||
        (caps.os
          ? caps.os + (caps.os_version ? ` ${caps.os_version}` : '')
          : '(unknown)');
      if (device) {
        const program =
          (caps.app || '').replace('sauce-storage:', '') || caps.browserName;
        const executing = program ? `executing ${program}` : '';

        env = `${device} on ${platform} ${version} ${executing}`.trim();
      } else {
        env = browser + (version ? ` (v${version})` : '') + ` on ${platform}`;
      }

      output += isMultiremote ? `- ${driverName}: ` : 'Driver: ';
      output += env;
      output += isLastIndex ? '' : '\n';
    });

    return output;
  }

  /**
   * Indent a suite based on where how it's nested
   * @param  {String} uid Unique suite key
   * @return {String}     Spaces for indentation
   */
  private indent(uid: string): string {
    const indents = this._suiteIndents[uid];
    return indents === 0 ? '' : Array(indents).join(DEFAULT_INDENT);
  }
  
  /**
 * Indent a suite based on where how it's nested
 * @param  {StateCount} stateCounts Stat count
 * @return {String}     String to the stat count to be displayed in Slack
 */
  private getCounts(stateCounts: StateCount): string {
    return `[Passed: *${stateCounts.passed}* | Failed: *${stateCounts.failed}* | Skipped: *${stateCounts.skipped}*]`;
  }
  
  /**
   * Indent a suite based on where how it's nested
   * @param  {string[]} tests Test titles to display
   * @return {String}     String to the test titles to be displayed in Slack
   */
  private getSuiteOutput(suite): ChatPostMessageArguments {
    const text = this.getScenarioOutput(suite)
    let item = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${text}`
      },
    }
    
    const payload: ChatPostMessageArguments = {
      channel: this._channel,
      text: `Results`,
      blocks: [
        item
      ],
    }
    return payload
  }
  
  private getFeatureResult(suites): any {
    let result = Object.values(suites).find(suite => {
      const tests = this.getEventsToReport(suite)
      if (tests.find((item) => item.state === 'failed')) {
        return true
      }
    })
    return result
  }
    
  private getScenarioOutput(suite): string {
    let tests = this.getEventsToReport(suite)
    let text = '```' + suite.title + '\n'
    tests.forEach((step) => {
      const symbol = this._symbols[step.state]
      text += `  ${symbol} ${step.title}\n`
    })
    return text + '```\n'
  }

  private getEventsToReport(suite) : Array<HookStats | TestStats>{
    return [
        /**
         * report all tests and only hooks that failed
         */
        ...suite.hooksAndTests
            .filter((item) => {
            return item.type === 'test' || Boolean(item.error);
        })
    ];
  }
    
  private getOrderedSuites() : Object {
    let orderedSuites = {}
    for (let suite of this._suites) {
        for (const [suiteUid, s] of Object.entries(this.suites)) {
            if (suite.uid !== suiteUid) {
                continue;
            }
            orderedSuites[suite.uid] = suite
        }
    }
    return orderedSuites
  }

  private createFailedTestPayload(
    hookAndTest: HookStats | TestStats
  ): ChatPostMessageArguments {
    const stack = hookAndTest.error?.stack ? '```' + this.convertErrorStack(hookAndTest.error.stack) + '```' : '';
    const payload: ChatPostMessageArguments = {
      channel: this._channel,
      text: `${this._symbols.failed} Error`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${this._symbols.failed} Error`
          },
        },
      ],
      attachments: [
        {
          color: FAILED_COLOR,
          title: `${
            this._currentScenario ? this._currentScenario.title : hookAndTest.parent
          }`,
          text: `* » ${hookAndTest.title}*\n${stack}`,
        },
      ],
    };
    return payload;
  }


  private createResultPayload(
    runnerStats: RunnerStats,
    stateCounts: StateCount
  ): ChatPostMessageArguments {
    const resultsUrl = SlackReporter.getResultsUrl();
    const counts = this.getCounts(stateCounts);
    const suites = this.getOrderedSuites();
    const failedTest = this.getFeatureResult(suites)
    const result = failedTest ? FEATURE_FAILED : FEATURE_PASSED
    const title = `*${this._currentFeature.title}*`
    const driver = `${this.getEnviromentCombo(
      this._runnerStats.capabilities,
      this._runnerStats.isMultiremote
    )}`
    const payload: ChatPostMessageArguments = {
      channel: this._channel,
      text: '',
      blocks: [],
      attachments: [
        {
          color: DEFAULT_COLOR,
          text: `${title} | Environment: *${this._env}*`
        },
        {
          color: failedTest ? FAILED_COLOR : SUCCESS_COLOR,
          text: `*${result}* ${counts} <${resultsUrl}|results>\n`,
          footer: `Duration: ${runnerStats.duration / 1000}s Started by: ${this._username} ${driver}`,
        },
      ],
    };

    return payload;
  }

  private sendResultThreadPayload() {
    const suites = this.getOrderedSuites();
    let result = []
    Object.values(suites).forEach(suite => {
      const output = this.getSuiteOutput(suite)
      if (output) {
        this._slackRequestQueue.push({
          type: SLACK_REQUEST_TYPE.WEB_API_POST_MESSAGE,
          payload: output as ChatPostMessageArguments,
          isDetailResult: true,
        });
      }
      if (this._uploadScreenshotOfFailedCase && this._screenshotBuffers[suite.uid]) {
        this._slackRequestQueue.push({
          type: SLACK_REQUEST_TYPE.WEB_API_UPLOAD,
          payload: this.createScreenshotPayload(
            suite as SuiteStats,
            this._screenshotBuffers[suite.uid]
          ) as FilesUploadArguments,
          isDetailResult: true
        });
        this._screenshotBuffers[suite.uid] = null;
      }
      
    });
    this._screenshotBuffers = {}
  }

  onRunnerStart(runnerStats: RunnerStats): void {
    this._runnerStats = runnerStats
  }

  // onBeforeCommand(commandArgs: BeforeCommandArgs): void {}
  // onAfterCommand(commandArgs: AfterCommandArgs): void {}
  /**
   * This hook is called twice:
   * 1. create the feature
   * 2. add the scenario to the feature
  */
  onSuiteStart(suiteStats: SuiteStats): void {
    switch (suiteStats.type) {
      case TEST_TYPES.FEATURE: {
        this._currentFeature = suiteStats
        break
      } case TEST_TYPES.SCENARIO: {
        this._currentScenario = suiteStats
        this._suites.push(suiteStats)
        break
      }
    }
}

  // onHookStart(hookStat: HookStats): void {}
  /**
   * This one is for the end of the hook, it directly comes after the onHookStart
   * A hook is the same  as a 'normal' step, so use the update step
   */
  onHookEnd(hookStats: HookStats): void {
  }

  // Run for every step
  onTestPass(stepStats: TestStats): void {
    this._stateCounts.passed++;
  }
  // Run for every step
  onTestFail(stepStats: TestStats): void {
    this._stateCounts.failed++;

  }
  // onTestRetry(testStats: TestStats): void {}
  onTestSkip(stepStats: TestStats): void {
    this._stateCounts.skipped++;
  }

  // onTestEnd(testStats: TestStats): void {}

  // onSuiteEnd(suiteStats: SuiteStats): void {}

  onRunnerEnd(runnerStats: RunnerStats): void {
    if (this._notifyTestFinishMessage) {
      try {
        if (this._client) {
          this._slackRequestQueue.push({
            type: SLACK_REQUEST_TYPE.WEB_API_POST_MESSAGE,
            payload: this.createResultPayload(
              runnerStats,
              this._stateCounts
            ) as ChatPostMessageArguments,
          });
          // Send results in thread
          this.sendResultThreadPayload()
        }
      } catch (error) {
        log.error(error);
        throw error;
      }
    }

    this._hasRunnerEnd = true;
  }

  private uploadFailedTestScreenshot(suite, buffer: Buffer): void {
    if (this._client) {
      if (this._uploadScreenshotOfFailedCase) {
        this._screenshotBuffers[suite.id]=buffer;
        return;
      } else {
        log.warn(ERROR_MESSAGES.DISABLED_OPTIONS);
      }
    } else {
      log.warn(ERROR_MESSAGES.NOT_USING_WEB_API);
    }
  }

  private createScreenshotPayload(
    suiteStats: SuiteStats,
    screenshotBuffer: Buffer
  ): FilesUploadArguments {
    const payload: FilesUploadArguments = {
      channels: this._channel,
      filename: `${suiteStats.title}.png`,
      filetype: 'png',
      file: screenshotBuffer,
    };
    return payload;
  }
}

export default SlackReporter;
export { SlackReporterOptions };
export * from './types';

declare global {
  namespace WebdriverIO {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface ReporterOption extends SlackReporterOptions {}
  }
  namespace NodeJS {
    interface Process {
      emit(
        event: typeof EVENTS.POST_MESSAGE,
        payload: ChatPostMessageArguments
      ): boolean;
      emit(
        event: typeof EVENTS.UPLOAD,
        payload: FilesUploadArguments
      ): Promise<WebAPICallResult>;
      emit(
        event: typeof EVENTS.RESULT,
        args: {
          result: WebAPICallResult | undefined;
          error: any;
        }
      ): boolean;
      emit(event: typeof EVENTS.SCREENSHOT, step, buffer: Buffer): boolean;

      on(
        event: typeof EVENTS.POST_MESSAGE,
        listener: (
          payload: ChatPostMessageArguments
        ) => Promise<WebAPICallResult>
      ): this;
      on(
        event: typeof EVENTS.UPLOAD,
        listener: (payload: FilesUploadArguments) => Promise<WebAPICallResult>
      ): this;
      on(
        event: typeof EVENTS.SCREENSHOT,
        listener: (buffer: Buffer) => void
      ): this;
      once(
        event: typeof EVENTS.RESULT,
        listener: (args: {
          result: WebAPICallResult | undefined;
          error: any;
        }) => Promise<void>
      ): this;
    }
  }
}
