// Opening the cockpit is a read action. A board meeting can call multiple model lanes and create a
// new approval queue, so it must be explicit by default. Operators that deliberately want the old
// launch behavior can opt in without changing the packaged app.

function meetingOnLaunch(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(String(env.SEEN_MEETING_ON_LAUNCH || '').trim());
}

module.exports = { meetingOnLaunch };
