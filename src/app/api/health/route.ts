// Health probe for the custom server and process liveness. Deliberately
// DB-free so orchestrators can poll it without a database connection.
export async function GET() {
  return Response.json({ status: 'ok' })
}
