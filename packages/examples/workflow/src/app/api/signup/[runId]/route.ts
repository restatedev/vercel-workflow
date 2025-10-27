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

import { NextResponse, NextRequest } from "next/server.js";
import { getRun } from "workflow/api";

interface RouteParams {
  params: Promise<{
    runId: string;
  }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { runId } = await params;

  const run = getRun(runId);
  const status = await run.status;

  let res: unknown = undefined;
  if (status === "completed") {
    res = await run.returnValue;
  }

  return NextResponse.json({
    status: await run.status,
    result: res,
  });
}
