const processQueues = new Map<string, Promise<void>>();

export async function withProcessQueue<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = processQueues.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  processQueues.set(key, tail);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (processQueues.get(key) === tail) processQueues.delete(key);
  }
}
