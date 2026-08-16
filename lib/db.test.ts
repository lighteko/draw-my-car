import { describe, expect, it } from "vitest";
import { getJob, updateJob } from "./db";

describe("internal job namespaces", () => {
  it("cannot be read or mutated through the generation-job API", async () => {
    const id = "room-state:abc23:1";

    await expect(getJob(id)).resolves.toBeUndefined();
    await expect(updateJob(id, { status: "processing" })).resolves.toBeUndefined();
  });
});
