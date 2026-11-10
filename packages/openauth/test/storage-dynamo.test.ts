import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { DynamoStorage } from "../src/storage/dynamo.js"
import { Storage } from "../src/storage/storage.js"

// Minimal in-memory DynamoDB endpoint supporting the actions DynamoStorage uses.
const items = new Map<string, any>()
const id = (key: any) => `${key.pk.S}|${key.sk.S}`
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  process.env.AWS_ACCESS_KEY_ID = "test"
  process.env.AWS_SECRET_ACCESS_KEY = "test"
  process.env.AWS_REGION = "us-east-1"
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const action = req.headers.get("X-Amz-Target")!.split(".")[1]
      const body = (await req.json()) as any
      switch (action) {
        case "PutItem":
          items.set(id(body.Item), body.Item)
          return Response.json({})
        case "GetItem":
          return Response.json({ Item: items.get(id(body.Key)) })
        case "DeleteItem":
          items.delete(id(body.Key))
          return Response.json({})
        case "Query": {
          const pk = body.ExpressionAttributeValues[":pk"].S
          const sk = body.ExpressionAttributeValues[":sk"]?.S ?? ""
          return Response.json({
            Items: [...items.values()].filter(
              (item) => item.pk.S === pk && item.sk.S.startsWith(sk),
            ),
          })
        }
      }
      return new Response("unsupported", { status: 400 })
    },
  })
})

afterAll(() => {
  server.stop()
})

beforeEach(() => {
  items.clear()
})

const storage = () =>
  DynamoStorage({
    table: "test",
    endpoint: `http://localhost:${server.port}`,
  })

test("scan returns keys that can be passed to remove", async () => {
  const adapter = storage()
  await Storage.set(adapter, ["oauth:refresh", "user:1", "token-a"], {})
  await Storage.set(adapter, ["oauth:refresh", "user:1", "token-b"], {})
  await Storage.set(adapter, ["oauth:refresh", "user:2", "token-c"], {})

  const keys: string[][] = []
  for await (const [key] of Storage.scan(adapter, ["oauth:refresh", "user:1"]))
    keys.push(key)
  expect(keys.sort()).toEqual([
    ["oauth:refresh", "user:1", "token-a"],
    ["oauth:refresh", "user:1", "token-b"],
  ])

  for (const key of keys) await Storage.remove(adapter, key)

  expect(
    await Storage.get(adapter, ["oauth:refresh", "user:1", "token-a"]),
  ).toBeUndefined()
  expect(
    await Storage.get(adapter, ["oauth:refresh", "user:1", "token-b"]),
  ).toBeUndefined()
  expect(
    await Storage.get(adapter, ["oauth:refresh", "user:2", "token-c"]),
  ).toEqual({})
})
