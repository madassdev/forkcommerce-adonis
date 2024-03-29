"use strict";
var randomstring = require("randomstring");
const moment = require("moment");
const Payment = use("App/Models/Payment");
const Store = use("App/Models/Store");
const User = use("App/Models/User");
var paystack = require("paystack")(
  "sk_test_a335450a82025ce1b4143aebfad5351966dd658b"
);
const Event = use("Event");
const Subscription = use("App/Models/Subscription");
const Bank = use("App/Models/Bank");
const { validate } = use("Validator");
const { formatters } = use("Validator");

class PaymentController {
  async makePayment({ request, response, auth }) {
    const rules = {
      medium: "required",
    };

    const validation = await validate(request.all(), rules, formatters.JsonApi);
    if (validation.fails()) {
      let errors = await validation.messages();
      return response.status(422).json({ success: false, data: errors });
    }

    if (request.input("medium") == "paystack") {
      return this.paystackPayment({ request, response, auth });
    } else if (request.input("medium") == "bank-transfer") {
      return this.bankTransferPayment({ request, response, auth });
    } else {
      return response.status(405).json({
        success: false,
        data: { message: "Enter a valid payment medium." },
      });
    }
  }

  async paystackPayment({ request, response, auth }) {
    const rules = {
      subscription_id: "required|number",
      reference: "required",
    };

    const validation = await validate(request.all(), rules, formatters.JsonApi);
    if (validation.fails()) {
      let errors = await validation.messages();
      return response.status(422).json({ success: false, data: errors });
    }

    const reference = await Payment.query()
      .where("reference", request.input("reference"))
      .first();

    if (reference) {
      return response.status(404).json({
        success: false,
        data: { message: "Transaction has been approved before." },
      });
    }

    const subscription = await Subscription.query()
      .where({ id: request.input("subscription_id"), user_id: auth.user.id })
      .first();

    if (subscription.status == "paid") {
      return response.status(405).json({
        success: false,
        data: { message: "Subscription already paid for." },
      });
    }

    if (subscription.status == "pending") {
      return response.status(405).json({
        success: false,
        data: {
          message: "Subscription already paid for and awaiting approval.",
        },
      });
    }

    const paymentStatus = await paystack.transaction.verify(
      request.input("reference")
    );
    if (!paymentStatus.status) {
      return response.status(405).json({
        success: false,
        data: { message: "Payment not verified from Paystack." },
      });
    }
    // return paymentStatus

    let payment = {
      medium: "paystack",
      user_id: auth.user.id,
      subscription_id: subscription.id,
      price_point: subscription.price_point,
      reference: request.input("reference"),
      depositor: auth.user.first_name + " " + auth.user.last_name,
      status: "success",
    };

    const admin = await User.find(1);
    const user = auth.user;

    payment = await Payment.create(payment);

    Event.fire("paystack-payment::received", payment, user, admin);

    subscription.status = "paid";
    await subscription.save();

    const store = await Store.find(subscription.store_id);
    store.status = "paid";

    await store.save();

    return response.status(200).json({
      success: true,
      data: {
        message: "Payment successful, your app will be ready in minutes...",
      },
    });
  }

  async bankTransferPayment({ request, response, auth }) {
    const rules = {
      subscription_id: "required|number",
      depositor: "required",
      bank_id: "required|number",
    };

    const validation = await validate(request.all(), rules, formatters.JsonApi);
    if (validation.fails()) {
      let errors = await validation.messages();
      return response.status(422).json({ success: false, data: errors });
    }

    const bank = await Bank.find(request.input("bank_id"));

    if (!bank) {
      return response
        .status(404)
        .json({ success: false, data: { message: "Bank not found." } });
    }

    const subscription = await Subscription.query()
      .where({ id: request.input("subscription_id"), user_id: auth.user.id })
      .first();

    if (!subscription) {
      return response
        .status(404)
        .json({ success: false, data: { message: "Subscription not found." } });
    }

    if (subscription.status == "paid") {
      return response.status(405).json({
        success: false,
        data: { message: "Subscription already paid for." },
      });
    }

    if (subscription.status == "pending") {
      return response.status(405).json({
        success: false,
        data: {
          message: "Subscription already paid for and awaiting approval.",
        },
      });
    }

    let payment = {
      medium: "bank-transfer",
      user_id: auth.user.id,
      subscription_id: subscription.id,
      price_point: subscription.price_point,
      depositor: request.input("depositor"),
      bank_id: request.input("bank_id"),
      status: "pending",
    };
    payment = await Payment.create(payment);

    subscription.status = "pending";
    subscription.save();

    return response.status(200).json({
      success: true,
      data: { message: "Payment submitted and awaiting verification." },
    });
  }

  async userPayments({ request, response, auth }) {
    const payments = await Payment.query()
      .where("user_id", auth.user.id)
      .with("subscription")
      .with("bank")
      .fetch();
    if (payments.size() === 0) {
      return response.status(404).json({
        success: false,
        data: { message: "No payment record found." },
      });
    }

    return response.json({ success: true, data: { payments: payments } });
  }

  async allPayments({ request, response, auth, params }) {
    if (auth.user.id != 1) {
      return response
        .status(403)
        .json({ success: false, data: { message: "Forbidden action." } });
    }

    const payments = await Payment.query()
      .with("user")
      .with("subscription.plan")
      .with("bank")
      // .forPage(1, 20)
      .fetch();
    if (payments.size() == 0) {
      return response.status(404).json({
        success: false,
        data: { message: "No payment record found." },
      });
    }

    return response.json({ success: true, data: { payments: payments } });
  }

  async queryPayments({ request, response, auth }) {
    if (auth.user.id != 1) {
      return response
        .status(403)
        .json({ success: false, data: { message: "Forbidden action." } });
    }

    const rules = {
      medium: "required",
      status: "required",
    };

    const validation = await validate(request.all(), rules, formatters.JsonApi);
    if (validation.fails()) {
      let errors = await validation.messages();
      return response.status(422).json({ success: false, data: errors });
    }

    if (
      !(
        request.input("medium") == "paystack" ||
        request.input("medium") == "bank-transfer"
      )
    ) {
      return response.status(405).json({
        success: false,
        data: { message: "Enter a valid payment medium." },
      });
    }

    const payments = await Payment.query()
      .where({
        medium: request.input("medium"),
        status: request.input("status"),
      })
      .with("user")
      .with("subscription.plan")
      .with("bank")
      .fetch();

    if (payments.size() == 0) {
      return response.status(404).json({
        success: false,
        data: { message: "No payment record found." },
      });
    }

    return response.json({ success: true, data: { payments: payments } });
  }

  async approvePayment({ request, response, auth }) {
    if (auth.user.id != 1) {
      return response
        .status(403)
        .json({ success: false, data: { message: "Forbidden action." } });
    }

    const rules = {
      payment_id: "required",
    };

    const validation = await validate(request.all(), rules, formatters.JsonApi);
    if (validation.fails()) {
      let errors = await validation.messages();
      return response.status(422).json({ success: false, data: errors });
    }

    const payment = await Payment.find(request.input("payment_id"));
    if (!payment) {
      return response
        .status(404)
        .json({ success: false, data: { message: "Payment not found." } });
    }

    if (payment.status == "success") {
      return response.status(405).json({
        success: false,
        data: { message: "This payment was successful." },
      });
    }

    payment.status = "success";
    await payment.save();

    const subscription = await Subscription.find(payment.subscription_id);
    subscription.status = "paid";
    await subscription.save();

    const store = await Store.find(subscription.store_id);
    store.status = "paid";
    await store.save();

    const user = await User.find(payment.user_id);

    Event.fire("bank-transfer-payment::approved", payment, user);

    return response.status(200).json({
      success: true,
      data: {
        message: "Payment approved, subscription approved",
        payment: payment,
        subscription: subscription,
      },
    });
  }

  async disprovePayment({ request, response, auth }) {
    if (auth.user.id != 1) {
      return response
        .status(403)
        .json({ success: false, data: { message: "Forbidden action." } });
    }

    const rules = {
      payment_id: "required",
    };

    const validation = await validate(request.all(), rules, formatters.JsonApi);
    if (validation.fails()) {
      let errors = await validation.messages();
      return response.status(422).json({ success: false, data: errors });
    }

    const payment = await Payment.find(request.input("payment_id"));
    if (!payment) {
      return response
        .status(404)
        .json({ success: false, data: { message: "Payment not found." } });
    }

    if (payment.status == "success") {
      return response.status(405).json({
        success: false,
        data: { message: "This payment was successful." },
      });
    }

    payment.status = "disproved";
    await payment.save();

    const subscription = await Subscription.find(payment.subscription_id);
    subscription.status = "disproved";
    await subscription.save();
    await subscription.delete();

    const store = await Store.find(subscription.store_id);
    store.status = "unpaid";
    await store.save();

    const user = await User.find(payment.user_id);

    return response.status(200).json({
      success: true,
      data: {
        message: "Payment approved, subscription approved",
        payment: payment,
        subscription: subscription,
      },
    });
  }
}

module.exports = PaymentController;
