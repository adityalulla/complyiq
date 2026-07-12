import { NotificationChannel, NotificationType } from '@prisma/client';
import { prisma } from '../db';

/**
 * A thin interface so the rest of the app never talks to a specific vendor
 * directly. Swap StubProvider for a real one (SendGrid for email, Twilio for
 * SMS/WhatsApp) by changing only the file below - nothing else in the app
 * needs to know which vendor is behind it.
 */
interface NotificationProvider {
  send(to: string, message: string): Promise<void>;
}

/**
 * Logs instead of actually sending - safe default for local development and
 * for this sandbox, which has no internet access to call a real provider
 * anyway. Replace with SendGridProvider/TwilioProvider below before real use.
 */
class StubProvider implements NotificationProvider {
  constructor(private channelName: string) {}
  async send(to: string, message: string) {
    console.log(`[STUB ${this.channelName}] would send to ${to}: "${message}"`);
  }
}

// --- Real providers you'd wire in before launch (left as clear TODOs since
// they need real API keys and can't be tested in this environment) ---
//
// class SendGridEmailProvider implements NotificationProvider {
//   async send(to: string, message: string) {
//     // const sgMail = require('@sendgrid/mail');
//     // sgMail.setApiKey(process.env.SENDGRID_API_KEY);
//     // await sgMail.send({ to, from: 'alerts@suvidha.app', subject: 'Suvidha alert', text: message });
//   }
// }
//
// class TwilioProvider implements NotificationProvider {
//   constructor(private mode: 'sms' | 'whatsapp') {}
//   async send(to: string, message: string) {
//     // const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
//     // const from = this.mode === 'whatsapp' ? 'whatsapp:+14155238886' : process.env.TWILIO_SMS_FROM;
//     // await twilio.messages.create({ to: this.mode === 'whatsapp' ? `whatsapp:${to}` : to, from, body: message });
//   }
// }

const providers: Record<NotificationChannel, NotificationProvider> = {
  EMAIL: new StubProvider('EMAIL'),
  SMS: new StubProvider('SMS'),
  WHATSAPP: new StubProvider('WHATSAPP'),
};

interface CreateNotificationInput {
  businessId: string;
  userId: string;
  type: NotificationType;
  channel: NotificationChannel;
  message: string;
  sendTo: string; // email address or phone number, depending on channel
}

/** Creates the notification record and attempts to send it right away. */
export async function createAndSendNotification(input: CreateNotificationInput) {
  const notification = await prisma.notification.create({
    data: {
      businessId: input.businessId,
      userId: input.userId,
      type: input.type,
      channel: input.channel,
      message: input.message,
    },
  });

  try {
    await providers[input.channel].send(input.sendTo, input.message);
    return prisma.notification.update({
      where: { id: notification.id },
      data: { sentAt: new Date() },
    });
  } catch (err) {
    console.error('Failed to send notification:', err);
    return notification; // sentAt stays null - a retry job could pick this up later
  }
}

/**
 * Scans for filings due soon and creates deadline reminders. Meant to be run
 * on a schedule (e.g. once a day) - see the README for how to wire up a cron
 * job, since this backend has no built-in scheduler yet.
 */
export async function sendUpcomingDeadlineReminders() {
  const in3Days = new Date();
  in3Days.setDate(in3Days.getDate() + 3);

  const upcomingFilings = await prisma.filing.findMany({
    where: {
      dueDate: { lte: in3Days, gte: new Date() },
      status: { in: ['DRAFT', 'READY_FOR_REVIEW', 'APPROVED'] },
    },
    include: {
      business: { include: { users: { include: { user: true } } } },
    },
  });

  let sent = 0;
  for (const filing of upcomingFilings) {
    const owners = filing.business.users.filter((u) => u.role === 'OWNER' || u.role === 'ADMIN');
    for (const owner of owners) {
      await createAndSendNotification({
        businessId: filing.businessId,
        userId: owner.userId,
        type: 'DEADLINE_REMINDER',
        channel: 'EMAIL',
        sendTo: owner.user.email,
        message: `Reminder: your ${filing.returnType} for ${filing.period} is due on ${filing.dueDate
          .toISOString()
          .slice(0, 10)} and is currently ${filing.status}.`,
      });
      sent++;
    }
  }
  return { remindersSent: sent };
}
