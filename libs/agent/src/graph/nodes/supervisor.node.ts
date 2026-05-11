export async function supervisorNode(state: { messages: any[] }) {
  const lastMessage = state.messages[state.messages.length - 1];

  if (lastMessage?.role === "user") {
    return {
      messages: [
        {
          role: "assistant",
          content: `Supervisor received: ${lastMessage.content}`,
        },
      ],
    };
  }

  return { messages: [] };
}
