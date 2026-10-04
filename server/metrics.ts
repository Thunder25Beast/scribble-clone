export interface ServerMetrics {
  messagesSent: number;
  messagesRecv: number;
  bytesSent: number;
  bytesRecv: number;
  slowClientDrops: number;
}

export const serverMetrics: ServerMetrics = {
  messagesSent: 0,
  messagesRecv: 0,
  bytesSent: 0,
  bytesRecv: 0,
  slowClientDrops: 0,
};

export function resetServerMetrics(): void {
  serverMetrics.messagesSent = 0;
  serverMetrics.messagesRecv = 0;
  serverMetrics.bytesSent = 0;
  serverMetrics.bytesRecv = 0;
  serverMetrics.slowClientDrops = 0;
}
