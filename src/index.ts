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
  FINISHED_COLOR,
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
  StepOutput,
  ScenarioOutput
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
  private _notifyFailedCase: boolean = true;
  private _notifyTestFinishMessage: boolean = true;
  private _isSynchronizing: boolean = false;
  private _interval: NodeJS.Timeout;
  private _hasRunnerEnd = false;
  private _suiteUids = new Set<string>();
  private _orderedSuites: SuiteStats[] = [];
  private _indents: number = 0;
  private _suiteIndents: Record<string, number> = {};
  private _currentFeature?: SuiteStats;
  private _currentScenario: SuiteStats;
  private _scenarios = {}
  private _featureStatus: string
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
      if (options.slackOptions.createResultDetailPayload) {
        this.createResultDetailPayload =
          options.slackOptions.createResultDetailPayload.bind(this);
        log.info(
          'The [createResultDetailPayload] function has been overridden.'
        );
        log.debug('RESULT', this.createResultDetailPayload.toString());
      }
    }
    this._symbols = {
      passed: options.emojiSymbols?.passed || EMOJI_SYMBOLS.PASSED,
      skipped: options.emojiSymbols?.skipped || EMOJI_SYMBOLS.SKIPPED,
      failed: options.emojiSymbols?.failed || EMOJI_SYMBOLS.FAILED,
      pending: options.emojiSymbols?.pending || EMOJI_SYMBOLS.PENDING,
      start: options.emojiSymbols?.start || EMOJI_SYMBOLS.ROKET,
      finished: options.emojiSymbols?.finished || EMOJI_SYMBOLS.CHECKERED_FLAG,
      watch: options.emojiSymbols?.watch || EMOJI_SYMBOLS.STOPWATCH,
    };
    this._title = options.title;

    if (options.resultsUrl !== undefined) {
      SlackReporter.setResultsUrl(options.resultsUrl);
    }

    if (options.notifyTestStartMessage !== undefined) {
      this._notifyTestStartMessage = options.notifyTestStartMessage;
    }

    if (options.notifyFailedCase !== undefined) {
      this._notifyFailedCase = options.notifyFailedCase;
    }

    if (options.notifyTestFinishMessage !== undefined) {
      this._notifyTestFinishMessage = options.notifyTestFinishMessage;
    }

    this._interval = global.setInterval(this.sync.bind(this), 100);

    process.on(EVENTS.POST_MESSAGE, this.postMessage.bind(this));
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
              this._lastSlackWebAPICallResult = result;
              log.debug('RESULT', util.inspect(result));
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
    return `Steps: \n${this._symbols.passed} Passed: ${stateCounts.passed} | ${this._symbols.failed} Failed: ${stateCounts.failed} | ${this._symbols.skipped} Skipped: ${stateCounts.skipped}`;
  }

  /**
   * Indent a suite based on where how it's nested
   * @param  {string[]} tests Test titles to display
   * @return {String}     String to the test titles to be displayed in Slack
   */
   private getTestOutput(): Array<any> {
    let result = []
    Object.keys(this._scenarios).forEach(scenario => {
      const text = this.getScenarioOutput(this._scenarios[scenario])
      let item = {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${text}`
        },
      }
      result.push(item)
    });
   
    return result
  }

  private getScenarioOutput(scenario: ScenarioOutput): string {
    let text = '```' + scenario.title + '\n'
    scenario.steps.forEach((step) => {
      const symbol = this._symbols[step.status]
      text += `  ${symbol} ${step.title}\n`
    })
    return text + '```\n'
  }

  private createStartPayload(
    runnerStats: RunnerStats
  ): ChatPostMessageArguments {
    const text = `${
      this._title ? '*Title*: `' + this._title + '`\n' : ''
    }${this.getEnviromentCombo(
      runnerStats.capabilities,
      runnerStats.isMultiremote
    )}`;

    const payload: ChatPostMessageArguments = {
      channel: this._channel,
      text: `${this._symbols.start} Start testing${
        this._title ? 'for ' + this._title : ''
      }`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${this._symbols.start} Starting tests`
          },
        },
      ],
      attachments: [
        {
          color: DEFAULT_COLOR,
          text,
          ts: Date.now().toString(),
        },
      ],
    };

    return payload;
  }

  private createFailedTestPayload(
    hookAndTest: HookStats | TestStats
  ): ChatPostMessageArguments {
    console.log("HHOKS", hookAndTest)
    const stack = hookAndTest.error?.stack
      ? '```' + this.convertErrorStack(hookAndTest.error.stack) + '```'
      : '';
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
    const resltsUrl = SlackReporter.getResultsUrl();
    const counts = this.getCounts(stateCounts);
    const output = this.getTestOutput()
    // const result = this._featureStatus === FEATURE_FAILED ? `${this._symbols.failed} ${FEATURE_FAILED}` : `${this._symbols.passed} ${FEATURE_PASSED}`
    const title = `${this._symbols.finished} End of test: *${this._currentFeature.title}*\n\n${this._currentFeature.description}\n`
    const payload: ChatPostMessageArguments = {
      channel: this._channel,
      text: `${this._symbols.finished} End of test${
        ' - ' + this._currentFeature.title
      }\n${counts}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: title,
          },
        },
        {
          type: 'divider'
        },
        ...output
      ],
      attachments: [
        {
          title: 'Results',
          title_link: resltsUrl,
          color: FINISHED_COLOR,
          text: `${counts}`,
          ts: Date.now().toString(),
          footer: `Duration: ${runnerStats.duration / 1000}s`
        },
      ],
    };

    return payload;
  }

  private createResultDetailPayload(
    runnerStats: RunnerStats,
    stateCounts: StateCount
  ): ChatPostMessageArguments {
    const counts = this.getCounts(stateCounts);
    const payload: ChatPostMessageArguments = {
      channel: this._channel,
      text: `${this._title ? this._title + '\n' : ''}${counts}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: this._title || '',
            emoji: true,
          },
        },
        ...this.getResultDetailPayloads(),
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${counts}\n${this._symbols.watch} ${
              runnerStats.duration / 1000
            }s`,
          },
        },
      ],
    };

    return payload;
  }

  private getResultDetailPayloads(): (Block | KnownBlock)[] {
    const output: string[] = [];
    const suites = this.getOrderedSuites();

    const blocks: (Block | KnownBlock)[] = [];

    for (const suite of suites) {
      // Don't do anything if a suite has no tests or sub suites
      if (
        suite.tests.length === 0 &&
        suite.suites.length === 0 &&
        suite.hooks.length === 0
      ) {
        continue;
      }

      // Get the indent/starting point for this suite
      const suiteIndent = this.indent(suite.uid);

      // Display the title of the suite
      if (suite.type) {
        output.push(`*${suiteIndent}${suite.title}*`);
      }

      // display suite description (Cucumber only)
      if (suite.description) {
        output.push(
          ...suite.description
            .trim()
            .split('\n')
            .map((l) => `${suiteIndent}${l.trim()}`)
        );
      }

      const eventsToReport = this.getEventsToReport(suite);
      for (const test of eventsToReport) {
        const testTitle = test.title;
        const testState = test.state;
        const testIndent = `${DEFAULT_INDENT}${suiteIndent}`;

        // Output for a single test
        output.push(
          `*${testIndent}${
            testState ? `${this._symbols[testState]} ` : ''
          }${testTitle}*`
        );
      }

      // Put a line break after each suite (only if tests exist in that suite)
      if (eventsToReport.length) {
        const block: Block | KnownBlock = {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: output.join('\n'),
          },
        };
        output.length = 0;
        blocks.push(block);
      }
    }
    return blocks;
  }

  private getOrderedSuites() {
    if (this._orderedSuites.length) {
      return this._orderedSuites;
    }

    this._orderedSuites = [];
    for (const uid of this._suiteUids) {
      for (const [suiteUid, suite] of Object.entries(this.suites)) {
        if (suiteUid !== uid) {
          continue;
        }

        this._orderedSuites.push(suite);
      }
    }

    return this._orderedSuites;
  }

  /**
   * returns everything worth reporting from a suite
   * @param  {Object}    suite  test suite containing tests and hooks
   * @return {Object[]}         list of events to report
   */
  private getEventsToReport(suite: SuiteStats) {
    return [
      /**
       * report all tests and only hooks that failed
       */
      ...suite.hooksAndTests.filter((item) => {
        return item.type === 'test' || Boolean(item.error);
      }),
    ];
  }

  onRunnerStart(runnerStats: RunnerStats): void {
    if (this._notifyTestStartMessage) {
      try {
        if (this._client) {
          log.info('INFO', `ON RUNNER START: POST MESSAGE`);
          this._slackRequestQueue.push({
            type: SLACK_REQUEST_TYPE.WEB_API_POST_MESSAGE,
            payload: this.createStartPayload(
              runnerStats
            ) as ChatPostMessageArguments,
          });
        }
      } catch (error) {
        log.error(error);
        throw error;
      }
    }
  }

  // onBeforeCommand(commandArgs: BeforeCommandArgs): void {}
  // onAfterCommand(commandArgs: AfterCommandArgs): void {}

  onSuiteStart(suiteStats: SuiteStats): void {
    switch (suiteStats.type) {
      case TEST_TYPES.FEATURE: {
        this._currentFeature = suiteStats
        break
      }
      case TEST_TYPES.SCENARIO: {
        this._currentScenario = suiteStats
        this._scenarios[suiteStats.uid] = {
          title: suiteStats.title,
          steps: [],
          id: suiteStats.uid
        }
        break
      }
    }
}

  // onHookStart(hookStat: HookStats): void {}
  onHookEnd(hookStats: HookStats): void {
    if (hookStats.error) {
      this._featureStatus = 'FAILED'
    }
  }

  // Run for every scenario step
  onTestPass(stepStats: TestStats): void {
    let step: StepOutput = {
      title: stepStats.title,
      status: 'passed'
    }
    this._stateCounts.passed++;
    this._scenarios[this._currentScenario.uid].steps.push(step)
  }
  onTestFail(stepStats: TestStats): void {
    let step: StepOutput = {
      title: stepStats.title,
      status: 'failed'
    }
    this._stateCounts.failed++;
    this._scenarios[this._currentScenario.uid].steps.push(step)
    if (this._notifyFailedCase) {
      if (this._client) {
        this._slackRequestQueue.push({
          type: SLACK_REQUEST_TYPE.WEB_API_POST_MESSAGE,
          payload: this.createFailedTestPayload(
            stepStats
          ) as ChatPostMessageArguments,
        });
      }
    }
  }
  // onTestRetry(testStats: TestStats): void {}
  onTestSkip(stepStats: TestStats): void {
    let step: StepOutput = {
      title: stepStats.title,
      status: 'skipped'
    }
    this._stateCounts.skipped++;
    this._scenarios[this._currentScenario.uid].steps.push(step)
  }

  // onTestEnd(testStats: TestStats): void {}

  onSuiteEnd(suiteStats: SuiteStats): void {
    this._indents--;
  }

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
        }
      } catch (error) {
        log.error(error);
        throw error;
      }
    }

    this._hasRunnerEnd = true;
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
