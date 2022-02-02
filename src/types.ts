/* eslint-disable @typescript-eslint/no-explicit-any */
import { ChatPostMessageArguments, FilesUploadArguments } from '@slack/web-api';
import { RunnerStats, TestStats } from '@wdio/reporter';
import { Reporters } from '@wdio/types';
import { SLACK_REQUEST_TYPE } from './constants';

export {
  ChatPostMessageArguments,
  FilesUploadArguments,
  WebAPICallResult,
} from '@slack/web-api';

export { RunnerStats, TestStats } from '@wdio/reporter';

export interface StateCount {
  passed: number;
  failed: number;
  skipped: number;
}

export interface EmojiSymbols {
  passed?: string;
  failed?: string;
  skipped?: string;
  pending?: string;
  start?: string;
  finished?: string;
  watch?: string;
}

export interface SlackWebApiOptions {
  type: 'web-api';
  channel: string;
  slackBotToken: string;
  uploadScreenshotOfFailedCase?: boolean;
  notifyDetailResultThread?: boolean;
  username?: string
  createScreenshotPayload?: (
    testStats: TestStats,
    screenshotBuffer: Buffer
  ) => FilesUploadArguments;
  createResultDetailPayload?: (
    runnerStats: RunnerStats,
    stateCounts: StateCount
  ) => ChatPostMessageArguments;
}

export type SlackOptions = SlackWebApiOptions;

export interface SlackReporterOptions extends Reporters.Options {
  slackOptions?: SlackOptions;
  emojiSymbols?: EmojiSymbols;
  title?: string;
  resultsUrl?: string;
  notifyFailedCase?: boolean;
  notifyTestStartMessage?: boolean;
  notifyTestFinishMessage?: boolean;
  createStartPayload?: (
    runnerStats: RunnerStats
  ) => ChatPostMessageArguments;
  createFailedTestPayload?: (
    testStats: TestStats
  ) => ChatPostMessageArguments;
  createResultPayload?: (
    runnerStats: RunnerStats,
    stateCounts: StateCount
  ) => ChatPostMessageArguments;
}

export type SlackRequestType = PostMessage | Upload;

interface PostMessage {
  type: typeof SLACK_REQUEST_TYPE.WEB_API_POST_MESSAGE;
  payload: ChatPostMessageArguments;
  isDetailResult?: boolean;
}
interface Upload {
  type: typeof SLACK_REQUEST_TYPE.WEB_API_UPLOAD;
  payload: FilesUploadArguments;
}

export interface StepOutput {
  title: string;
  status: string;
}

export interface ScenarioOutput {
  title: string;
  id: string;
  steps?: Array<StepOutput>;
}

export interface FeatureOutput {
  title: string;
  description: string;
  scenarios?: Array<ScenarioOutput>;
}