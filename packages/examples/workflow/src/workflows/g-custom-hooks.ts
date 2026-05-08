/* eslint-disable @typescript-eslint/require-await */
import { createHook } from "workflow";

interface SlackMessage {
  user: string;
  text: string;
}

export async function slackChannelBot(channelId: string) {
  "use workflow";
  // Use channel ID in the token so Slack webhooks can find this workflow
  using hook = createHook<SlackMessage>({
    token: `slack_messages:${channelId}`,
  });
  for await (const message of hook) {
    console.log(`${message.user}: ${message.text}`);
    if (message.text === "/stop") {
      break;
    }
    await processMessage(message);
  }
}
async function processMessage(message: SlackMessage) {
  "use step";
  // Process the Slack message
  console.log(`Processing message: ${message.text}`);
}
