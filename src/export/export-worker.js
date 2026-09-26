import { parentPort } from 'node:worker_threads';
import { buildAttendanceSpreadsheet } from './attendance-sheet.js';
import { buildStudentResponseSpreadsheet, buildTestSpreadsheet } from './spreadsheet.js';

const builders = {
  attendance: (data) => buildAttendanceSpreadsheet(data),
  student: (data, options) => buildStudentResponseSpreadsheet(data, options),
  test: (data) => buildTestSpreadsheet(data)
};

parentPort.on('message', async ({ id, type, data, options }) => {
  try {
    if (!builders[type]) throw new Error(`Unknown export type: ${type}`);
    const buffer = await builders[type](data, options);
    parentPort.postMessage({ id, buffer });
  } catch (error) {
    parentPort.postMessage({ id, error: error?.message || String(error), stack: error?.stack });
  }
});

