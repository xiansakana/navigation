import nodemailer from 'nodemailer';

export async function sendEmail(channel, message, options) {
    var smtp = channel?.smtp || {};
    if (!smtp.host) throw new Error('邮件渠道缺少 SMTP 主机');
    if (!channel.to) throw new Error('邮件渠道缺少默认收件人');

    var transporter = nodemailer.createTransport({
        host: smtp.host,
        port: Number(smtp.port) || 465,
        secure: smtp.secure !== false,
        auth: smtp.user ? { user: smtp.user, pass: smtp.pass || '' } : undefined,
        disableFileAccess: true,
        disableUrlAccess: true
    });
    var opts = options || {};
    return transporter.sendMail({
        from: channel.from || smtp.user,
        to: opts.to || channel.to,
        subject: opts.subject || '通知管理测试消息',
        text: String(message)
    });
}
