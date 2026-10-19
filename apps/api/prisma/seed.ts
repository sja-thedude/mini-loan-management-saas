// Fictional demo data: two companies, so tenant isolation can be shown in the UI.
// Idempotent: skips a tenant whose slug already exists.
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { buildSchedule } from "../src/lib/money";
import { prisma, withTenant } from "../src/lib/db";

const PASSWORD = "DemoPassword123!";

const companies = [
  { name: "Acme Lending", slug: "acme", customers: [["Ava Fictional", "ava@acme.example", 650_000n], ["Ben Sample", "ben@acme.example", 420_000n], ["Cara Demo", "cara@acme.example", 910_000n]] },
  { name: "Bluebird Finance", slug: "bluebird", customers: [["Dan Placeholder", "dan@bluebird.example", 380_000n], ["Eve Testcase", "eve@bluebird.example", 720_000n]] },
] as const;

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 12);
  for (const co of companies) {
    if (await prisma.tenant.findUnique({ where: { slug: co.slug } })) {
      console.log(`skip ${co.slug} (exists)`);
      continue;
    }
    const tenantId = randomUUID();
    await withTenant(tenantId, async (tx) => {
      await tx.tenant.create({ data: { id: tenantId, name: co.name, slug: co.slug } });
      const admin = await tx.user.create({ data: { tenantId, email: `admin@${co.slug}.example`, fullName: `${co.name} Admin`, passwordHash: hash, role: "ADMIN" } });
      await tx.user.create({ data: { tenantId, email: `officer@${co.slug}.example`, fullName: `${co.name} Officer`, passwordHash: hash, role: "OFFICER" } });

      for (const [i, [fullName, email, income]] of co.customers.entries()) {
        const c = await tx.customer.create({ data: { tenantId, fullName, email, monthlyIncomeCents: income } });
        const principal = BigInt(5_000_00 + i * 7_500_00);
        const status = (["APPROVED", "PENDING", "REJECTED"] as const)[i % 3];
        const loan = await tx.loan.create({
          data: {
            tenantId, customerId: c.id, principalCents: principal, annualRateBps: 900 + i * 150, termMonths: 12 + i * 12,
            purpose: ["Fictional delivery van", "Fictional shop renovation", "Fictional working capital"][i % 3],
            status, createdById: admin.id,
            ...(status !== "PENDING" ? { decidedById: admin.id, decidedAt: new Date() } : {}),
          },
        });
        if (status === "APPROVED") {
          const start = new Date(Date.UTC(2026, 3, 15));
          const rows = buildSchedule(loan.principalCents, loan.annualRateBps, loan.termMonths, start);
          await tx.installment.createMany({
            data: rows.map(({ balanceAfterCents: _b, ...r }) => ({ ...r, tenantId, loanId: loan.id, ...(r.number <= 3 ? { status: "PAID" as const, paidAt: r.dueDate } : {}) })),
          });
        }
        await tx.auditLog.create({ data: { tenantId, userId: admin.id, action: "seed.loan_created", entityType: "loan", entityId: loan.id } });
      }
    });
    console.log(`seeded ${co.slug}: admin@${co.slug}.example / officer@${co.slug}.example, password ${PASSWORD}`);
  }
}

main().finally(() => prisma.$disconnect());
