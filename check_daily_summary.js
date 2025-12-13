const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: process.env.DATABASE_URL
      }
    }
  });

  try {
    // Check if table exists by querying it
    console.log('Checking DailySummary table...\n');
    
    const summaries = await prisma.dailySummary.findMany();
    console.log(`✅ DailySummary table exists!`);
    console.log(`Found ${summaries.length} records\n`);
    
    // Get table info
    const tableInfo = await prisma.$queryRaw`
      DESCRIBE DailySummary;
    `;
    
    console.log('Table Structure:');
    console.table(tableInfo);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
