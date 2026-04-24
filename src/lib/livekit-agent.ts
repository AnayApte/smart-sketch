/**
 * Registered worker name for the Python LiveKit agent (`agent/main.py` WorkerOptions.agent_name).
 * Also embedded in participant JWT roomConfig so LiveKit dispatches the worker when the room is created.
 */
export const SMARTSKETCH_AGENT_NAME = 'smartsketch-worker';
