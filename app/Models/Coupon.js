"use strict";

/** @type {typeof import('@adonisjs/lucid/src/Lucid/Model')} */
const Model = use("Model");

class Coupon extends Model {
  static boot() {
    super.boot();

    this.addTrait("@provider:Lucid/SoftDeletes");
  }

  plan() {
    return this.belongsTo("App/Models/Plan");
  }

  subscriptions() {
    return this.hasMany("App/Models/Subscription");
  }
}

module.exports = Coupon;
