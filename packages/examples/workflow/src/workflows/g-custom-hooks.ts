import { createHook } from "workflow";
import { triggerResume } from "./_callback.js";

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

  // Simulate an external chat platform calling our resume endpoint, which
  // delivers a fixed sequence of messages (including "/stop").
  await triggerResume("g-resume", {});

  const messages: SlackMessage[] = [];
  for await (const message of hook) {
    messages.push(message);
    if (message.text === "/stop") {
      break;
    }
    await processMessage(message);
  }
  return { channelId, messages };
}
async function processMessage(message: SlackMessage) {
  "use step";
  // Process the Slack message
  console.log(`Processing message: ${message.text}`);
}
