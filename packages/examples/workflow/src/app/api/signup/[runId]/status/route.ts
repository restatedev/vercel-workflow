/*
 * Copyright (c) TODO: Add copyright holder
 *
 * This file is part of TODO: Add project name,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * TODO: Add repository URL
 */

import { NextResponse } from "next/server.js";
import { getRun } from "workflow/api";

interface RouteParams {
  params: {
    runId: string;
  };
}

export async function GET(request: Request, { params }: RouteParams) {
  const { runId } = await params;
  const run = getRun(runId);
  return new NextResponse(run.getReadable({startIndex: 0}), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
  })
}
