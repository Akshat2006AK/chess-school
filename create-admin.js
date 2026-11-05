/**
 * Create initial admin user
 * Run with: node create-admin.js
 */

const { db, userOps, hashPassword } = require('./database');
const { v4: uuidv4 } = require('uuid');

async function createAdmin() {
  const username = process.argv[2] || 'admin';
  const password = process.argv[3] || 'admin123';

  try {
    // Check if admin already exists
    const existing = userOps.getByUsername.get(username.toLowerCase());
    if (existing) {
      if (existing.is_admin) {
        console.log(`Admin user "${username}" already exists`);
        // Update to ensure admin status
        userOps.setAdmin.run(1, existing.id);
        console.log('Admin status confirmed');
      } else {
        userOps.setAdmin.run(1, existing.id);
        userOps.updateStatus.run('approved', existing.id);
        console.log(`Updated existing user "${username}" to admin`);
      }
      process.exit(0);
    }

    const salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const passwordHash = await hashPassword(password, salt);
    const userId = uuidv4();

    // Insert as admin with approved status
    db.prepare(`
      INSERT INTO users (id, username, password_hash, salt, is_admin, registration_status)
      VALUES (?, ?, ?, ?, 1, 'approved')
    `).run(userId, username, passwordHash, salt);

    db.prepare(`
      INSERT INTO user_stats (user_id, wins, draws, losses, games_played)
      VALUES (?, 0, 0, 0, 0)
    `).run(userId);

    console.log(`✅ Admin user created successfully!`);
    console.log(`   Username: ${username}`);
    console.log(`   Password: ${password}`);
    console.log(`   User ID: ${userId}`);
    console.log(`\n⚠️  Please change the password after first login!`);

  } catch (e) {
    console.error('Error creating admin:', e);
    process.exit(1);
  } finally {
    db.close();
  }
}

createAdmin();